import { expect, onTestFinished, test } from "bun:test";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import { startFakeSlack } from "./index";
import shapes from "./live-shapes.json";

function atPath(value: unknown, path: string): unknown {
  for (const field of path.split("."))
    value = z.record(z.string(), z.unknown()).parse(value)[field];
  return value;
}

function expectShape(value: unknown, shape: Record<string, string>) {
  for (const [path, type] of Object.entries(shape)) {
    const actual = atPath(value, path);
    expect({
      path,
      type: actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual,
    }).toEqual({ path, type });
  }
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the live-shape transcript.");
    await Bun.sleep(2);
  }
}

function clientOptions(slackApiUrl: string) {
  return {
    slackApiUrl,
    timeout: 1000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
  };
}

test("the supported SDK transcript matches captured live shapes and reply-deletion order", async () => {
  const fake = startFakeSlack();
  onTestFinished(() => fake.stop());
  const web = new WebClient(fake.botToken, clientOptions(fake.url));
  const socket = new SocketModeClient({
    appToken: fake.appToken,
    clientOptions: clientOptions(fake.url),
    logLevel: LogLevel.ERROR,
  });
  onTestFinished(() => socket.disconnect());
  const frames: unknown[] = [];
  const acknowledgements: Promise<void>[] = [];
  socket.on("ws_message", (data: string) => frames.push(JSON.parse(data)));
  socket.on("slack_event", (event: { ack(): Promise<void> }) => acknowledgements.push(event.ack()));
  await socket.start();
  await until(() => frames.length === 1);
  expectShape(frames[0], shapes.hello);
  const channel = fake.addChannel({ is_private: true });
  const metadata = { event_type: "toy_box_outbox", event_payload: { id: "post", hash: "hash" } };
  const root = await web.chat.postMessage({ channel, text: "Root", metadata });
  expectShape(root, shapes.post);
  await until(() => frames.length === 2);
  expectShape(frames[1], shapes.envelope);
  expectShape(frames[1], shapes.posted);
  const reply = await web.chat.postMessage({
    channel,
    thread_ts: root.ts!,
    text: "Reply",
    metadata,
  });
  await until(() => frames.length === 3);
  expectShape(frames[2], shapes.reply);
  const last = await web.chat.postMessage({ channel, thread_ts: root.ts!, text: "Last reply" });
  await until(() => frames.length === 4);
  const history = await web.conversations.history({ channel, include_all_metadata: true });
  expectShape(history, shapes.history);
  expect(history.messages?.map(({ ts }) => ts)).toEqual([root.ts]);
  expect(history.messages?.[0]?.metadata).toEqual(metadata);
  expect((await web.conversations.history({ channel })).messages?.[0]?.metadata).toEqual({
    event_type: metadata.event_type,
  });
  const edited = { user: fake.identity.botUserId, ts: root.ts };
  fake.setMessage(channel, { ...fake.getMessages(channel)[0]!, edited });
  expectShape(await web.chat.delete({ channel, ts: reply.ts! }), shapes.delete);
  await until(() => frames.length === 6);
  expectShape(frames[4], shapes.deleted);
  expectShape(frames[4], shapes.deletedReply);
  expect(atPath(frames[4], "payload.event.deleted_ts")).toBe(reply.ts);
  expect(atPath(frames[4], "payload.event.thread_ts")).toBeUndefined();
  expectShape(frames[5], shapes.changed);
  expectShape(frames[5], shapes.edited);
  expect(atPath(frames[5], "payload.event.message.reply_count")).toBe(1);
  expect(atPath(frames[5], "payload.event.message.latest_reply")).toBe(last.ts);
  expect(atPath(frames[5], "payload.event.message.edited")).toEqual(edited);
  await web.chat.delete({ channel, ts: last.ts! });
  await until(() => frames.length === 8);
  expectShape(frames[6], shapes.deleted);
  expectShape(frames[7], shapes.changed);
  expectShape(frames[7], shapes.emptyRoot);
  expect(atPath(frames[7], "payload.event.message.edited")).toEqual(edited);
  for (const field of ["thread_ts", "reply_count", "latest_reply"])
    expect(atPath(frames[7], `payload.event.message.${field}`)).toBeUndefined();
  await web.chat.delete({ channel, ts: root.ts! });
  await until(() => frames.length === 9);
  expectShape(frames[8], shapes.deleted);
  expect(fake.getMessages(channel)).toEqual([]);
  await Promise.all(acknowledgements);
  await until(() => fake.acks.length === 8);
});

test("a shared file matches its captured live shapes in history and files.info", async () => {
  const fake = startFakeSlack();
  onTestFinished(() => fake.stop());
  const web = new WebClient(fake.botToken, clientOptions(fake.url));
  const channel = fake.addChannel({ name: "general" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = fake.addFile(png, { user: "UALICE", name: "screenshot.png", mimetype: "image/png" });
  fake.setMessage(channel, { ts: "1.000001", user: "UALICE", files: [file] });
  const history = await web.conversations.history({ channel });
  expectShape(history.messages?.[0]?.files?.[0], shapes.historyFile);
  const info = await web.files.info({ file: file.id });
  expectShape(info, shapes.fileInfo);
  expectShape(info.file?.shares?.public?.[channel]?.[0], shapes.share);
});

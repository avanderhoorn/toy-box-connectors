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

test("the real SDK transcript matches observed live shapes and thread bookkeeping order", async () => {
  const fake = startFakeSlack({ pingIntervalMs: 20 });
  onTestFinished(() => fake.stop());
  const clientOptions = {
    slackApiUrl: fake.url,
    timeout: 1000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
  };
  const web = new WebClient(fake.botToken, clientOptions);
  const socket = new SocketModeClient({
    appToken: fake.appToken,
    clientOptions,
    clientPingTimeout: 200,
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
  const metadata = {
    event_type: "toy_box_outbox",
    event_payload: { item: "example", hash: "hash" },
  };
  const root = await web.chat.postMessage({ channel, text: "Root", metadata });
  expectShape(root, shapes.post);
  await until(() => frames.length === 2);
  expectShape(frames[1], shapes.envelope);
  expectShape(frames[1], shapes.posted);
  expect(atPath(frames[1], "retry_attempt")).toBe(0);
  expect(atPath(frames[1], "retry_reason")).toBe("");
  expect(atPath(frames[1], "payload.event.subtype")).toBeUndefined();
  const reply = await web.chat.postMessage({
    channel,
    thread_ts: root.ts!,
    text: "Reply",
    metadata,
  });
  await until(() => frames.length === 3);
  expectShape(frames[2], shapes.posted);
  expectShape(frames[2], shapes.reply);
  const broadcast = await web.chat.postMessage({
    channel,
    thread_ts: root.ts!,
    reply_broadcast: true,
    text: "Broadcast",
  });
  await until(() => frames.length === 4);
  expectShape(frames[3], shapes.broadcast);
  expect(atPath(frames[3], "payload.event.root.metadata")).toEqual({
    event_type: metadata.event_type,
  });
  expect(atPath(frames[3], "payload.event.root.reply_count")).toBe(2);
  const updated = await web.chat.update({ channel, ts: root.ts!, text: "Changed root" });
  expectShape(updated, shapes.update);
  expect(atPath(updated, "message.ts")).toBeUndefined();
  await until(() => frames.length === 6);
  expectShape(frames[4], shapes.changed);
  expectShape(frames[4], shapes.broadcastRootChanged);
  expect(atPath(frames[4], "payload.event.message.ts")).toBe(broadcast.ts);
  expect(atPath(frames[4], "payload.event.message.edited")).toBeUndefined();
  expectShape(frames[5], shapes.changed);
  expectShape(frames[5], shapes.edited);
  expect(atPath(frames[5], "payload.event.message.ts")).toBe(root.ts);
  const editVersion = atPath(frames[5], "payload.event.message.edited");
  const history = await web.conversations.history({ channel, include_all_metadata: true });
  expectShape(history, shapes.history);
  expect(history.messages?.find((message) => message.ts === root.ts)?.metadata).toEqual(metadata);
  expect(
    atPath(
      history.messages?.find((message) => message.ts === broadcast.ts),
      "root.metadata",
    ),
  ).toEqual({ event_type: metadata.event_type });
  expectShape(await web.chat.delete({ channel, ts: broadcast.ts! }), shapes.delete);
  await until(() => frames.length === 8);
  expectShape(frames[6], shapes.deleted);
  expectShape(frames[6], shapes.deletedReply);
  expect(atPath(frames[6], "payload.event.deleted_ts")).toBe(broadcast.ts);
  expect(atPath(frames[6], "payload.event.thread_ts")).toBeUndefined();
  expectShape(frames[7], shapes.changed);
  expectShape(frames[7], shapes.edited);
  expect(atPath(frames[7], "payload.event.message.reply_count")).toBe(1);
  expect(atPath(frames[7], "payload.event.message.latest_reply")).toBe(reply.ts);
  expect(atPath(frames[7], "payload.event.message.edited")).toEqual(editVersion);
  await web.chat.delete({ channel, ts: reply.ts! });
  await until(() => frames.length === 10);
  expectShape(frames[8], shapes.deleted);
  expectShape(frames[8], shapes.deletedReply);
  expect(atPath(frames[8], "payload.event.thread_ts")).toBeUndefined();
  expectShape(frames[9], shapes.changed);
  expectShape(frames[9], shapes.emptyRoot);
  expect(atPath(frames[9], "payload.event.message.edited")).toEqual(editVersion);
  for (const field of [
    "thread_ts",
    "reply_count",
    "reply_users_count",
    "reply_users",
    "latest_reply",
    "is_locked",
    "subscribed",
  ]) {
    expect(atPath(frames[9], `payload.event.message.${field}`)).toBeUndefined();
  }
  await web.chat.delete({ channel, ts: root.ts! });
  await until(() => frames.length === 11);
  expectShape(frames[10], shapes.deleted);
  expect(fake.getMessages(channel)).toEqual([]);
  await Promise.all(acknowledgements);
  await until(() => fake.acks.length === 10);
});

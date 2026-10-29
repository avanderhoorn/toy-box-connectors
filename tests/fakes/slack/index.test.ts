import { expect, onTestFinished, test } from "bun:test";
import { LogLevel, WebClient } from "@slack/web-api";
import { startFakeSlack } from "./index";

async function until(condition: () => boolean) {
  const end = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for fake Slack traffic.");
    await Bun.sleep(2);
  }
}

test("one-use app tickets and strict acknowledgements match the wire", async () => {
  let now = 100;
  const fake = startFakeSlack({ now: () => now });
  onTestFinished(() => fake.stop());
  const options = {
    slackApiUrl: fake.url,
    retryConfig: { retries: 0 },
    logLevel: LogLevel.ERROR,
  };
  await expect(
    new WebClient(fake.botToken, options).apps.connections.open({}),
  ).rejects.toMatchObject({ data: { error: "invalid_auth" } });
  const result = await new WebClient(fake.appToken, options).apps.connections.open({});
  const socket = new WebSocket(result.url!);
  onTestFinished(() => socket.close());
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
  await until(() => frames.length === 1);
  expect(frames[0]).toMatchObject({
    type: "hello",
    connection_info: { app_id: fake.identity.appId },
  });
  expect((await fetch(result.url!.replace("ws:", "http:"))).status).toBe(403);
  const sent = fake.sendEvent({ type: "message" }, { authorizations: undefined });
  await until(() => frames.length === 2);
  expect(frames[1]).toMatchObject({
    retry_attempt: 0,
    retry_reason: "",
  });
  expect(frames[1]!.payload).not.toHaveProperty("authorizations");
  expect(await fake.waitForAck(sent.envelopeId, 5)).toBeNull();
  now = 250;
  const body = { envelope_id: sent.envelopeId };
  socket.send(JSON.stringify(body));
  expect(await fake.waitForAck(body.envelope_id)).toEqual({
    envelopeId: body.envelope_id,
    at: 250,
    body,
  });
  socket.send(JSON.stringify(body));
  socket.send(JSON.stringify({ envelope_id: "never-sent" }));
  socket.close();
  await until(() => socket.readyState === WebSocket.CLOSED);
  await expect(fake.stop()).rejects.toThrow("unknown or already acked");
});

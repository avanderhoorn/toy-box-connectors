import { expect, onTestFinished, test } from "bun:test";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import { startFakeSlack, type FakeSlackApp } from "./index";

async function until(condition: () => boolean) {
  const end = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for fake Slack traffic.");
    await Bun.sleep(2);
  }
}

async function connect(app: FakeSlackApp, acknowledge = true) {
  const opened = await new WebClient(app.appToken, {
    slackApiUrl: app.url,
    retryConfig: { retries: 0 },
    logLevel: LogLevel.ERROR,
  }).apps.connections.open({});
  const socket = new WebSocket(opened.url!);
  onTestFinished(() => socket.close());
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener("message", ({ data }) => {
    const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(data));
    frames.push(frame);
    if (acknowledge && typeof frame.envelope_id === "string")
      socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
  });
  await until(() => frames.length === 1);
  expect(frames[0]).toMatchObject({
    type: "hello",
    connection_info: { app_id: app.identity.appId },
  });
  return {
    socket,
    hello: frames[0],
    events: () => frames.filter((frame) => frame.type === "events_api"),
  };
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

test("each member app gets one event while its sockets share deliveries", async () => {
  const fake = startFakeSlack();
  onTestFinished(() => fake.stop());
  const other = fake.addApp();
  const elsewhere = fake.addApp({ teamId: "TOTHER", enterpriseId: "EOTHER" });
  const channel = fake.addChannel();
  other.addChannel({ id: channel });
  const privateChannel = fake.addChannel({ is_private: true });
  const foreignChannel = elsewhere.addChannel();
  const a = await connect(fake);
  const a2 = await connect(fake);
  const b = await connect(other);
  const c = await connect(elsewhere);
  expect(a2.hello).toMatchObject({ num_connections: 2 });
  expect(b.hello).toMatchObject({ num_connections: 1 });
  expect(fake.activeConnections).toBe(2);
  expect(other.activeConnections).toBe(1);
  const message = { type: "message", user: "UALICE", text: "Question", ts: "1.000001" };
  const events = [
    message,
    { ...message, ts: "1.000002", thread_ts: message.ts },
    {
      type: "message",
      subtype: "message_changed",
      message: { ...message, text: "Edited", edited: { user: message.user, ts: "1.000003" } },
      previous_message: message,
      ts: "1.000003",
    },
    {
      type: "message",
      subtype: "message_deleted",
      deleted_ts: message.ts,
      previous_message: message,
      ts: "1.000004",
    },
  ];
  for (const event of events) {
    const deliveries = fake.broadcastEvent({ ...event, channel });
    expect(deliveries.map(({ appId }) => appId)).toEqual([
      fake.identity.appId,
      other.identity.appId,
    ]);
    expect(new Set(deliveries.map(({ envelopeId }) => envelopeId)).size).toBe(2);
    for (const [index, app] of [fake, other].entries())
      expect(await app.waitForAck(deliveries[index]!.envelopeId)).not.toBeNull();
  }
  const receivedA = [...a.events(), ...a2.events()];
  expect(receivedA).toHaveLength(events.length);
  expect(a.events().length).toBeGreaterThan(0);
  expect(a2.events().length).toBeGreaterThan(0);
  expect(b.events()).toHaveLength(events.length);
  expect(c.events()).toHaveLength(0);
  for (const [app, received] of [
    [fake, receivedA],
    [other, b.events()],
  ] as const) {
    for (const frame of received) {
      expect(frame.payload).toMatchObject({
        api_app_id: app.identity.appId,
        team_id: app.identity.teamId,
        authorizations: [{ user_id: app.identity.botUserId, is_bot: true }],
      });
    }
  }
  expect(
    fake.broadcastEvent({ ...message, channel: privateChannel }).map(({ appId }) => appId),
  ).toEqual([fake.identity.appId]);
  expect(
    fake.broadcastEvent({ ...message, channel: foreignChannel }).map(({ appId }) => appId),
  ).toEqual([elsewhere.identity.appId]);
  other.addChannel({ id: channel, is_member: false });
  expect(fake.broadcastEvent({ ...message, channel }).map(({ appId }) => appId)).toEqual([
    fake.identity.appId,
  ]);
  expect(
    fake
      .broadcastEvent({ type: "member_left_channel", channel, user: other.identity.botUserId })
      .map(({ appId }) => appId),
  ).toEqual([fake.identity.appId, other.identity.appId]);
  expect(() => fake.addApp({ appId: fake.identity.appId })).toThrow("already seeded");
});

test("API writes fan out with the sender's identity and each recipient's authorization", async () => {
  const fake = startFakeSlack();
  onTestFinished(() => fake.stop());
  const other = fake.addApp();
  const channel = fake.addChannel();
  other.addChannel({ id: channel });
  const a = await connect(fake);
  const b = await connect(other);
  const options = {
    slackApiUrl: fake.url,
    retryConfig: { retries: 0 },
    logLevel: LogLevel.ERROR,
  };
  const first = new WebClient(fake.botToken, options);
  const second = new WebClient(other.botToken, options);
  const root = await first.chat.postMessage({ channel, text: "A" });
  const reply = await second.chat.postMessage({ channel, thread_ts: root.ts!, text: "B" });
  await second.chat.delete({ channel, ts: reply.ts! });
  await until(() => fake.acks.length === 4 && other.acks.length === 4);
  for (const [app, received] of [
    [fake, a.events()],
    [other, b.events()],
  ] as const) {
    expect(received).toHaveLength(4);
    for (const frame of received) {
      expect(frame.payload).toMatchObject({
        api_app_id: app.identity.appId,
        authorizations: [{ user_id: app.identity.botUserId, is_bot: true }],
      });
    }
    expect(received[0]!.payload).toMatchObject({
      event: { user: fake.identity.botUserId, bot_id: fake.identity.botId, ts: root.ts },
    });
    expect(received[1]!.payload).toMatchObject({
      event: {
        user: other.identity.botUserId,
        bot_id: other.identity.botId,
        app_id: other.identity.appId,
        ts: reply.ts,
        thread_ts: root.ts,
      },
    });
    expect(received[2]!.payload).toMatchObject({
      event: { subtype: "message_deleted", deleted_ts: reply.ts },
    });
    expect(received[3]!.payload).toMatchObject({
      event: { subtype: "message_changed", message: { ts: root.ts } },
    });
  }
});

test("an app cannot acknowledge another app's delivery", async () => {
  const fake = startFakeSlack();
  onTestFinished(() => fake.stop());
  const other = fake.addApp();
  const a = await connect(fake, false);
  const b = await connect(other, false);
  const sentA = fake.sendEvent({ type: "message" });
  b.socket.send(JSON.stringify({ envelope_id: sentA.envelopeId }));
  const sentB = other.sendEvent({ type: "message" });
  b.socket.send(JSON.stringify({ envelope_id: sentB.envelopeId }));
  expect(await other.waitForAck(sentB.envelopeId)).not.toBeNull();
  expect(await fake.waitForAck(sentA.envelopeId, 5)).toBeNull();
  a.socket.send(JSON.stringify({ envelope_id: sentA.envelopeId }));
  expect(await fake.waitForAck(sentA.envelopeId)).not.toBeNull();
  await expect(fake.stop()).rejects.toThrow("unknown or already acked");
});

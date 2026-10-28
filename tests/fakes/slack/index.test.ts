import { expect, onTestFinished, test } from "bun:test";
import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode, LogLevel, WebClient } from "@slack/web-api";
import { startFakeSlack, type FakeSlack } from "./index";

function fakeSlack(options?: Parameters<typeof startFakeSlack>[0]) {
  const fake = startFakeSlack(options);
  onTestFinished(() => fake.stop());
  return fake;
}

function webClient(fake: FakeSlack, token = fake.botToken) {
  return new WebClient(token, {
    slackApiUrl: fake.url,
    timeout: 1000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
  });
}

async function socketClient(fake: FakeSlack) {
  const client = new SocketModeClient({
    appToken: fake.appToken,
    clientPingTimeout: 50,
    logLevel: LogLevel.ERROR,
    clientOptions: {
      slackApiUrl: fake.url,
      timeout: 1000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    },
  });
  onTestFinished(() => client.disconnect());
  await client.start();
  await until(() => fake.activeConnections === 1);
  return client;
}

async function until(condition: () => boolean) {
  const end = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for fake Slack traffic.");
    await Bun.sleep(2);
  }
}

function nextDelivery(client: SocketModeClient, type = "slack_event") {
  return new Promise<{
    body: Record<string, unknown>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    ack(): Promise<void>;
  }>((resolve) => client.once(type, resolve));
}

function nextConnection(client: SocketModeClient) {
  return new Promise<void>((resolve) => client.once("connected", resolve));
}

test("apps.connections.open authenticates the app token and returns a one-use socket ticket", async () => {
  const fake = fakeSlack();
  const client = webClient(fake, fake.appToken);
  const result = await client.apps.connections.open({});
  expect(result.url).toStartWith("ws://127.0.0.1:");
  await expect(webClient(fake).apps.connections.open({})).rejects.toMatchObject({
    code: ErrorCode.PlatformError,
    data: { error: "invalid_auth" },
  });
  const socket = new WebSocket(result.url!);
  onTestFinished(() => socket.close());
  const hello = await new Promise<MessageEvent>((resolve) =>
    socket.addEventListener("message", resolve, { once: true }),
  );
  expect(JSON.parse(hello.data)).toMatchObject({
    type: "hello",
    connection_info: { app_id: fake.identity.appId },
  });
  expect((await fetch(result.url!.replace("ws:", "http:"))).status).toBe(403);
});

test("the real Socket Mode SDK waits for an explicit ack, which the fake timestamps", async () => {
  let now = 100;
  const fake = fakeSlack({ now: () => now });
  const client = await socketClient(fake);
  const incoming = nextDelivery(client);
  const delivery = fake.sendEvent(
    { type: "message", channel: "C1", ts: "1.000001", text: "Question" },
    { eventId: "Ev1" },
  );
  const event = await incoming;
  expect(fake.acks).toEqual([]);
  expect(event.body.event_id).toBe("Ev1");
  expect(await fake.waitForAck(delivery.envelopeId, 5)).toBeNull();
  now = 250;
  await event.ack();
  await until(() => fake.acks.length === 1);
  expect(await fake.waitForAck(delivery.envelopeId)).toEqual({
    envelopeId: delivery.envelopeId,
    connectionId: 1,
    at: 250,
    payload: {},
    body: { envelope_id: delivery.envelopeId, payload: {} },
  });
  expect(fake.deliveries[0].sentAt).toBe(100);
});

test("unacked redelivery retains the event ID, exposes retries, and allows a distinct envelope ID", async () => {
  const fake = fakeSlack();
  const client = await socketClient(fake);
  const first = nextDelivery(client);
  const delivery = fake.sendEvent({ type: "message" }, { eventId: "Ev1" });
  await first;
  const second = nextDelivery(client);
  const retry = fake.redeliver(delivery.envelopeId, "retry-envelope");
  const event = await second;
  expect(event.body.event_id).toBe("Ev1");
  expect(event.envelope_id).toBe("retry-envelope");
  expect(event.retry_num).toBe(1);
  expect(event.retry_reason).toBe("timeout");
  expect(retry.frame.payload).toEqual(delivery.frame.payload);
  await event.ack();
  await until(() => fake.acks.length === 1);
  expect(() => fake.redeliver("retry-envelope")).toThrow("already acked");
});

test("button clicks retain their raw payload and get an envelope-specific ack", async () => {
  const fake = fakeSlack();
  const client = await socketClient(fake);
  const click = {
    type: "block_actions",
    api_app_id: fake.identity.appId,
    team: { id: fake.identity.teamId },
    user: { id: "WOWNER", team_id: "TSIBLING" },
    container: { type: "message", channel_id: "C1", message_ts: "1.000001" },
    actions: [{ action_id: "approval.approve", value: "proposal" }],
  };
  const incoming = nextDelivery(client, "interactive");
  fake.sendInteraction(click, "click-envelope");
  const event = await incoming;
  expect(event.body).toEqual(click);
  await event.ack();
  await until(() => fake.acks.length === 1);
  expect(fake.acks[0].envelopeId).toBe("click-envelope");
});

test("authorization variants survive the real SDK without fake-side repair", async () => {
  const fake = fakeSlack({ identity: { enterpriseId: "E1" } });
  const client = await socketClient(fake);
  for (const authorizations of [
    undefined,
    [],
    null,
    "malformed",
    [{ team_id: "TOTHER", user_id: "UOTHER", is_bot: true }],
  ]) {
    const incoming = nextDelivery(client);
    fake.sendEvent({ type: "message" }, { authorizations });
    const event = await incoming;
    if (authorizations === undefined)
      expect(Object.hasOwn(event.body, "authorizations")).toBe(false);
    else expect(event.body.authorizations).toEqual(authorizations);
    await event.ack();
  }
  await until(() => fake.acks.length === 5);
});

test("refresh_requested makes the SDK acquire another socket and hello can name a different app", async () => {
  const fake = fakeSlack();
  const client = await socketClient(fake);
  const connected = nextConnection(client);
  const frames: unknown[] = [];
  client.on("ws_message", (data: string) => frames.push(JSON.parse(data)));
  fake.setNextHelloAppId("AOTHER");
  fake.disconnect("refresh_requested");
  await connected;
  await until(() => fake.connections.length === 2);
  expect(fake.calls.filter(({ method }) => method === "apps.connections.open")).toHaveLength(2);
  expect(fake.connections[0].closedAt).not.toBeNull();
  expect(frames).toContainEqual(
    expect.objectContaining({ type: "hello", connection_info: { app_id: "AOTHER" } }),
  );
});

test("an abrupt drop is observable and the SDK reconnects", async () => {
  const fake = fakeSlack();
  const client = await socketClient(fake);
  const connected = nextConnection(client);
  fake.dropConnections();
  await connected;
  expect(fake.connections).toHaveLength(2);
});

test("a silent peer with no pongs triggers the SDK heartbeat before the socket is dropped", async () => {
  const fake = fakeSlack({ pingIntervalMs: 10 });
  const client = await socketClient(fake);
  fake.setSocketResponsive(false);
  try {
    await until(() => client.websocket?.readyState === WebSocket.CLOSING);
    expect(fake.connections).toHaveLength(1);
    const connected = nextConnection(client);
    // Let the already-started close handshake finish instead of waiting for its 30-second limit.
    fake.setSocketResponsive(true);
    await connected;
    expect(fake.connections).toHaveLength(2);
  } finally {
    fake.setSocketResponsive(true);
  }
});

test("unknown methods and unexpected arguments fail the SDK call and fake cleanup", async () => {
  const fake = fakeSlack();
  await expect(
    webClient(fake, fake.appToken).apiCall("apps.connections.open", { surprise: true }),
  ).rejects.toMatchObject({
    code: ErrorCode.PlatformError,
    data: { error: "invalid_arguments" },
  });
  await expect(webClient(fake).apiCall("imaginary.success", {})).rejects.toMatchObject({
    code: ErrorCode.PlatformError,
  });
  await expect(fake.stop()).rejects.toThrow("Unexpected fake Slack traffic");
});

test("connections.open failures preserve platform errors and per-method Retry-After", async () => {
  const fake = fakeSlack();
  const client = webClient(fake, fake.appToken);
  fake.failNext("apps.connections.open", { error: "token_revoked" });
  await expect(client.apps.connections.open({})).rejects.toMatchObject({
    code: ErrorCode.PlatformError,
    data: { error: "token_revoked" },
  });
  fake.failNext("apps.connections.open", { retryAfter: 2 });
  await expect(client.apps.connections.open({})).rejects.toMatchObject({
    code: ErrorCode.RateLimitedError,
    retryAfter: 2,
  });
  expect(fake.calls).toHaveLength(2);
  expect((await client.apps.connections.open({})).url).toStartWith("ws:");
});

test("a bare ack is recorded and a second or unknown ack fails cleanup", async () => {
  const fake = fakeSlack();
  const result = await webClient(fake, fake.appToken).apps.connections.open({});
  const socket = new WebSocket(result.url!);
  onTestFinished(() => socket.close());
  await new Promise<void>((resolve) =>
    socket.addEventListener("message", () => resolve(), { once: true }),
  );
  const delivery = fake.sendEvent({ type: "message" });
  const body = { envelope_id: delivery.envelopeId };
  socket.send(JSON.stringify(body));
  expect(await fake.waitForAck(delivery.envelopeId)).toMatchObject({ body });
  socket.send(JSON.stringify(body));
  socket.send(JSON.stringify({ envelope_id: "never-sent" }));
  await Bun.sleep(5);
  await expect(fake.stop()).rejects.toThrow("unknown or already acked");
});

test("real Web API writes produce Socket Mode message, edit and delete events", async () => {
  const fake = fakeSlack();
  const client = await socketClient(fake);
  const channel = fake.addChannel();
  const web = webClient(fake);
  let incoming = nextDelivery(client);
  const post = await web.chat.postMessage({ channel, text: "First" });
  let event = await incoming;
  expect(event.body.event).toMatchObject({
    channel,
    text: "First",
    ts: post.ts,
    bot_id: fake.identity.botId,
  });
  await event.ack();
  incoming = nextDelivery(client);
  await web.chat.update({ channel, ts: post.ts!, text: "Edited" });
  event = await incoming;
  expect(event.body.event).toMatchObject({
    subtype: "message_changed",
    message: {
      ts: post.ts,
      text: "Edited",
      edited: { user: fake.identity.botUserId, ts: expect.any(String) },
    },
    previous_message: { text: "First" },
  });
  await event.ack();
  incoming = nextDelivery(client);
  await web.chat.delete({ channel, ts: post.ts! });
  event = await incoming;
  expect(event.body.event).toMatchObject({ subtype: "message_deleted", deleted_ts: post.ts });
  await event.ack();
  await until(() => fake.acks.length === 3);
});

test("a misplaced reply is stored, emitted and returned as a new root, once", async () => {
  const fake = fakeSlack();
  const client = await socketClient(fake);
  const channel = fake.addChannel();
  const web = webClient(fake);
  const question = { type: "message", ts: "1.000001", user: "U1", text: "Question" };
  fake.setMessage(channel, question);
  const thread = { channel_id: channel, thread_ts: question.ts };
  await web.assistant.threads.setStatus({ ...thread, status: "Thinking" });
  fake.failNext("chat.postMessage", { misplacedReply: true });
  let incoming = nextDelivery(client);
  const stray = await web.chat.postMessage({ channel, thread_ts: question.ts, text: "Answer" });
  let event = await incoming;
  const root = {
    team: fake.identity.teamId,
    user: fake.identity.botUserId,
    bot_id: fake.identity.botId,
    text: "Answer",
    ts: stray.ts,
  };
  expect(stray).toMatchObject({ ok: true, channel, message: root });
  expect(event.body.event).toMatchObject({ ...root, channel, event_ts: stray.ts });
  for (const message of [stray.message, event.body.event, fake.getMessages(channel)[1]]) {
    expect(message).not.toHaveProperty("thread_ts");
    expect(message).not.toHaveProperty("parent_user_id");
  }
  await event.ack();
  expect(fake.getMessages(channel)[0]).toEqual(question);
  expect(fake.getThreadStatus(channel, question.ts)).toBe("Thinking");

  incoming = nextDelivery(client);
  const reply = await web.chat.postMessage({ channel, thread_ts: question.ts, text: "Answer" });
  event = await incoming;
  expect(reply.message).toMatchObject({ thread_ts: question.ts, parent_user_id: "U1" });
  expect(event.body.event).toMatchObject({ ts: reply.ts, thread_ts: question.ts });
  await event.ack();
  expect(fake.getMessages(channel)[0]).toMatchObject({ reply_count: 1, latest_reply: reply.ts });
  expect(fake.getThreadStatus(channel, question.ts)).toBeNull();
  await until(() => fake.acks.length === 2);
});

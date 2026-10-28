import { expect, onTestFinished, test } from "bun:test";
import type { WebSocketHandler } from "bun";
import type { SocketFrame } from "@slackapi/model/envelopes";
import type { CallFailure } from "@slackapi/server/botClient";
import { openSlackSocket, type SlackSocketOptions } from "@slackapi/server/socketMode";
import { startFakeSlack, type FakeSlack, type FakeSlackFailure } from "../fakes/slack";
import { waitFor } from "./waitFor";

const NOW = Date.parse("2026-10-28T09:00:00Z");

/** A fake Slack with a clock the test moves. */
function fakeSlack() {
  let now = NOW;
  const fake = startFakeSlack({ now: () => now });
  onTestFinished(() => fake.stop());
  return {
    fake,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A connection to `slack`, with every frame it handed over. */
function connect(
  slack: ReturnType<typeof fakeSlack>,
  {
    appToken = slack.fake.appToken,
    ...options
  }: Partial<SlackSocketOptions> & { appToken?: string } = {},
) {
  const frames: { frame: SocketFrame; arrivedAt: number }[] = [];
  const socket = openSlackSocket(appToken, {
    slackApiUrl: slack.fake.url,
    onFrame: (frame, arrivedAt) => frames.push({ frame, arrivedAt }),
    now: slack.now,
    ...options,
  });
  onTestFinished(() => socket.close());
  return { socket, frames };
}

/** A Slack whose socket `websocket` serves, or that refuses the socket when there's none. */
function slackServing(websocket?: WebSocketHandler<undefined>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/socket") {
        return Response.json({
          ok: true,
          url: new URL("/socket", server.url).href.replace("http", "ws"),
        });
      }
      if (websocket && server.upgrade(request)) return;
      return new Response("Invalid ticket", { status: 403 });
    },
    websocket: websocket ?? { message() {} },
  });
  onTestFinished(() => server.stop(true));
  return new URL("/api/", server.url).href;
}

function sendMessage(fake: FakeSlack, text: string) {
  return fake.sendEvent({ type: "message", channel: "C1", user: "U1", text, ts: "1.000001" });
}

test("a connection opens at Slack's hello and hands over every frame when it arrived", async () => {
  const slack = fakeSlack();
  const { socket, frames } = connect(slack);

  expect(await socket.opened).toEqual({ kind: "open" });
  slack.advance(1_000);
  const first = sendMessage(slack.fake, "one");
  const second = sendMessage(slack.fake, "two");
  await waitFor(() => expect(frames).toHaveLength(3));

  expect(frames).toEqual([
    { frame: { kind: "hello", appId: "AFAKE" }, arrivedAt: NOW },
    {
      frame: expect.objectContaining({ kind: "event", envelopeId: first.envelopeId }),
      arrivedAt: NOW + 1_000,
    },
    {
      frame: expect.objectContaining({ kind: "event", envelopeId: second.envelopeId }),
      arrivedAt: NOW + 1_000,
    },
  ]);
});

test("a connection is open once Slack says hello, even when the caller closes it there", async () => {
  const slack = fakeSlack();
  const { socket } = connect(slack, { onFrame: () => socket.close() });

  expect(await socket.opened).toEqual({ kind: "open" });
  await socket.closed;
});

test("binary frames aren't handed over, since Slack sends none", async () => {
  const slackApiUrl = slackServing({
    open(ws) {
      ws.send(JSON.stringify({ type: "hello", connection_info: { app_id: "A1" } }));
      ws.send(new TextEncoder().encode(JSON.stringify({ type: "disconnect", reason: "binary" })));
      ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    },
    message() {},
  });
  const frames: SocketFrame[] = [];
  const socket = openSlackSocket("xapp-test", {
    slackApiUrl,
    onFrame: (frame) => frames.push(frame),
  });
  onTestFinished(() => socket.close());

  await socket.closed;

  expect(frames).toEqual([
    { kind: "hello", appId: "A1" },
    { kind: "disconnect", reason: "refresh_requested" },
  ]);
});

test("an ack reaches Slack", async () => {
  const slack = fakeSlack();
  const { socket, frames } = connect(slack);
  await socket.opened;
  const delivery = sendMessage(slack.fake, "one");
  await waitFor(() => expect(frames).toHaveLength(2));

  socket.ack(delivery.envelopeId);

  expect((await slack.fake.waitForAck(delivery.envelopeId))?.body).toEqual({
    envelope_id: delivery.envelopeId,
  });
});

test("Slack's disconnect frame is handed over, and then the connection closes", async () => {
  const slack = fakeSlack();
  const { socket, frames } = connect(slack);
  await socket.opened;
  slack.advance(5);

  slack.fake.disconnect("refresh_requested");

  expect(await socket.closed).toBe(NOW + 5);
  expect(frames.at(-1)).toEqual({
    frame: { kind: "disconnect", reason: "refresh_requested" },
    arrivedAt: NOW + 5,
  });
  await waitFor(() => expect(slack.fake.activeConnections).toBe(0));
});

test("a connection whose pings go unanswered closes", async () => {
  const slack = fakeSlack();
  const { socket } = connect(slack, { pingTimeoutMs: 150 });
  await socket.opened;

  slack.fake.setSocketResponsive(false);

  expect(await socket.closed).toBe(NOW);
});

test("closing a connection ends it at once, and an ack after that sends nothing", async () => {
  const slack = fakeSlack();
  const { socket, frames } = connect(slack);
  await socket.opened;
  const delivery = sendMessage(slack.fake, "one");
  await waitFor(() => expect(frames).toHaveLength(2));
  slack.advance(5);

  socket.close();
  socket.ack(delivery.envelopeId);

  expect(await socket.closed).toBe(NOW + 5);
  await waitFor(() => expect(slack.fake.activeConnections).toBe(0));
  expect(slack.fake.acks).toEqual([]);
});

test("a connection that said hello outlives the hello timeout", async () => {
  const slack = fakeSlack();
  const { socket } = connect(slack, { helloTimeoutMs: 20 });
  await socket.opened;

  await Bun.sleep(100);

  expect(slack.fake.activeConnections).toBe(1);
  expect(await Promise.race([socket.closed, "open"])).toBe("open");
});

test("closing never waits on Slack", async () => {
  const slack = fakeSlack();
  const { socket } = connect(slack);
  await socket.opened;
  slack.fake.setSocketResponsive(false);

  socket.close();

  expect(await Promise.race([socket.closed, Bun.sleep(1_000).then(() => "waiting")])).toBe(NOW);
});

test("closing before Slack answers apps.connections.open opens nothing", async () => {
  const slack = fakeSlack();
  const { socket } = connect(slack);

  socket.close();

  expect(await socket.opened).toEqual({ kind: "closed" });
  await socket.closed;
  // A connection the closed one opened anyway would reach Slack before the next one could.
  await connect(slack).socket.opened;
  expect(slack.fake.calls.map(({ method }) => method)).toEqual([
    "apps.connections.open",
    "apps.connections.open",
  ]);
  expect(slack.fake.connections).toHaveLength(1);
});

test.each<[string, FakeSlackFailure, CallFailure]>([
  ["a rate limit", { retryAfter: 30 }, { kind: "rate_limited", retryAfterSeconds: 30 }],
  [
    "an error",
    { error: "not_allowed_token_type" },
    { kind: "error", error: "not_allowed_token_type", data: expect.anything() },
  ],
  ["an HTTP error", { status: 503 }, { kind: "unknown", detail: "HTTP 503" }],
])("apps.connections.open failing with %s opens nothing", async (_, failure, expected) => {
  const slack = fakeSlack();
  slack.fake.failNext("apps.connections.open", failure);
  const { socket } = connect(slack);

  expect(await socket.opened).toEqual({ kind: "failed", failure: expected });
  await socket.closed;
  expect(slack.fake.connections).toEqual([]);
});

test("an app token Slack rejects opens nothing", async () => {
  const slack = fakeSlack();
  const { socket } = connect(slack, { appToken: "xapp-revoked" });

  expect(await socket.opened).toEqual({
    kind: "failed",
    failure: { kind: "auth_failed", error: "invalid_auth" },
  });
  await socket.closed;
  expect(slack.fake.connections).toEqual([]);
});

test("apps.connections.open that never answers fails once the call times out", async () => {
  const slack = fakeSlack();
  slack.fake.failNext("apps.connections.open", { lostResponse: true });
  const { socket } = connect(slack, { timeoutMs: 50 });

  expect(await socket.opened).toEqual({
    kind: "failed",
    failure: { kind: "unknown", detail: "The operation timed out." },
  });
  await socket.closed;
});

test("a connection Slack never says hello on is dropped", async () => {
  let connections = 0;
  const slackApiUrl = slackServing({
    open: () => void connections++,
    close: () => void connections--,
    message() {},
  });
  const socket = openSlackSocket("xapp-test", {
    slackApiUrl,
    helloTimeoutMs: 50,
    onFrame: () => {},
  });
  onTestFinished(() => socket.close());

  expect(await socket.opened).toEqual({
    kind: "dropped",
    detail: "Slack didn't say hello in time",
  });
  await socket.closed;
  await waitFor(() => expect(connections).toBe(0));
});

test("a connection that closes before Slack says hello is dropped", async () => {
  const socket = openSlackSocket("xapp-test", {
    slackApiUrl: slackServing(),
    onFrame: () => {},
  });
  onTestFinished(() => socket.close());

  expect(await socket.opened).toEqual({
    kind: "dropped",
    detail: "the connection closed before Slack said hello",
  });
  await socket.closed;
});

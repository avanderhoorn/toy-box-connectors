import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode, LogLevel, WebClient } from "@slack/web-api";
import { WebSocketServer } from "ws";

async function fakeSlack(t, handleApi) {
  const sockets = [];
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const call = {
      path: request.url,
      method: request.url.slice("/api/".length),
      body: new URLSearchParams(bytes.toString()),
      bytes,
    };
    calls.push(call);
    response.setHeader("Content-Type", "application/json");
    if (call.method === "apps.connections.open") {
      response.end(JSON.stringify({ ok: true, url: websocketUrl }));
    } else {
      handleApi(call, response);
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        connection_info: { app_id: "A_FAKE" },
        num_connections: 1,
        debug_info: { approximate_connection_time: 3600 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const websocketUrl = `ws://127.0.0.1:${port}/socket`;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });
  return {
    sockets,
    calls,
    slackApiUrl: `http://127.0.0.1:${port}/api/`,
  };
}

function webClient(fake, options = {}) {
  return new WebClient("xoxb-fake-for-local-tests-only", {
    slackApiUrl: fake.slackApiUrl,
    allowAbsoluteUrls: false,
    timeout: 1000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
    ...options,
  });
}

function eventEnvelope(envelopeId, retryAttempt = 0) {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    accepts_response_payload: false,
    retry_attempt: retryAttempt,
    retry_reason: retryAttempt ? "timeout" : undefined,
    payload: {
      type: "event_callback",
      api_app_id: "A_FAKE",
      team_id: "T_FAKE",
      event_id: "Ev_same_event",
      event_time: 1793145600,
      event: {
        type: "message",
        channel: "C_FAKE",
        user: "U_FAKE",
        text: "Question",
        ts: "1793145600.000001",
        thread_ts: "1793000000.000001",
      },
    },
  };
}

test("Socket Mode preserves explicit ack control, retries, and refresh", async (t) => {
  const fake = await fakeSlack(t, (_call, response) => {
    response.end(JSON.stringify({ ok: false, error: "unexpected_method" }));
  });
  const client = new SocketModeClient({
    appToken: "xapp-fake-for-local-tests-only",
    clientPingTimeout: 500,
    serverPingTimeout: 3000,
    logLevel: LogLevel.ERROR,
    clientOptions: {
      slackApiUrl: fake.slackApiUrl,
      timeout: 1000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    },
  });
  try {
    await client.start();
    const socket = fake.sockets[0];
    let acks = 0;
    socket.on("message", () => {
      acks += 1;
    });

    const incoming = once(client, "slack_event");
    socket.send(JSON.stringify(eventEnvelope("envelope-first")));
    const [delivery] = await incoming;
    assert.equal(delivery.body.event.thread_ts, "1793000000.000001");
    await sleep(20);
    assert.equal(acks, 0, "the SDK must not ack before application persistence");
    const acked = once(socket, "message");
    const ackStart = performance.now();
    await delivery.ack();
    const [ackBytes] = await acked;
    assert.equal(JSON.parse(ackBytes.toString()).envelope_id, "envelope-first");
    assert.ok(performance.now() - ackStart < 3000);

    const duplicate = once(client, "slack_event");
    socket.send(JSON.stringify(eventEnvelope("envelope-retry", 1)));
    const [retry] = await duplicate;
    assert.equal(retry.body.event_id, delivery.body.event_id);
    assert.equal(retry.retry_num, 1);
    assert.equal(retry.envelope_id, "envelope-retry");
    const retryAck = once(socket, "message");
    await retry.ack();
    await retryAck;
    assert.equal(acks, 2, "each envelope needs its own ack despite business dedupe");

    const reconnected = once(client, "connected");
    socket.send(
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
    );
    await reconnected;
    assert.equal(fake.sockets.length, 2);
    assert.equal(
      fake.calls.filter((call) => call.method === "apps.connections.open").length,
      2,
    );
  } finally {
    await client.disconnect();
  }
});

test("429 exposes Retry-After to a durable scheduler without hidden retry", async (t) => {
  const fake = await fakeSlack(t, (_call, response) => {
    response.statusCode = 429;
    response.setHeader("Retry-After", "2");
    response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
  });
  await assert.rejects(
    webClient(fake).conversations.history({ channel: "C_FAKE", limit: 15 }),
    (error) =>
      error.code === ErrorCode.RateLimitedError && error.retryAfter === 2,
  );
  assert.equal(fake.calls.length, 1);
});

test("HTTP-200 Slack permission failures remain explicit platform errors", async (t) => {
  const fake = await fakeSlack(t, (_call, response) => {
    response.end(JSON.stringify({ ok: false, error: "missing_scope" }));
  });
  await assert.rejects(
    webClient(fake).conversations.replies({
      channel: "C_FAKE",
      ts: "1793000000.000001",
      limit: 15,
    }),
    (error) =>
      error.code === ErrorCode.PlatformError &&
      error.data.error === "missing_scope",
  );
  assert.equal(fake.calls.length, 1);
});

test("SDK retries can repeat a non-idempotent post after a lost response", async (t) => {
  let accepted = 0;
  const fake = await fakeSlack(t, (_call, response) => {
    accepted += 1;
    if (accepted === 1) {
      response.destroy();
    } else {
      response.end(
        JSON.stringify({ ok: true, channel: "C_FAKE", ts: "1793145600.000002" }),
      );
    }
  });
  const result = await webClient(fake, {
    retryConfig: {
      retries: 1,
      minTimeout: 1,
      maxTimeout: 1,
      randomize: false,
    },
  }).chat.postMessage({ channel: "C_FAKE", text: "One intended publication" });
  assert.equal(result.ok, true);
  assert.equal(accepted, 2, "automatic transport retries can duplicate delivery");
});

test("disabling SDK retries leaves an ambiguous send for application reconciliation", async (t) => {
  const fake = await fakeSlack(t, (_call, response) => {
    response.destroy();
  });
  await assert.rejects(
    webClient(fake).chat.postMessage({
      channel: "C_FAKE",
      text: "One intended publication",
    }),
    (error) => error.code === ErrorCode.RequestError,
  );
  assert.equal(fake.calls.length, 1);
});

test("cursor pagination continues through an empty page", async (t) => {
  const fake = await fakeSlack(t, (call, response) => {
    const cursor = call.body.get("cursor");
    response.end(
      JSON.stringify(
        cursor
          ? {
              ok: true,
              messages: [{ ts: "1793145600.000001", text: "Recovered" }],
              response_metadata: { next_cursor: "" },
            }
          : {
              ok: true,
              messages: [],
              response_metadata: { next_cursor: "page=two" },
            },
      ),
    );
  });
  const pages = [];
  for await (const page of webClient(fake).paginate("conversations.history", {
    channel: "C_FAKE",
    limit: 15,
    oldest: "1793000000.000000",
    latest: "1793145601.000000",
  })) {
    pages.push(page);
  }
  assert.equal(pages.length, 2);
  assert.equal(pages[1].messages.length, 1);
  assert.equal(fake.calls[1].body.get("cursor"), "page=two");
  assert.equal(fake.calls[1].body.get("oldest"), "1793000000.000000");
  assert.equal(fake.calls[1].body.get("latest"), "1793145601.000000");
});

test("uploadV2 preserves binary content and the target thread across three stages", async (t) => {
  const bytes = Buffer.from([0, 1, 2, 128, 254, 255]);
  const fake = await fakeSlack(t, (call, response) => {
    if (call.method === "files.getUploadURLExternal") {
      response.end(
        JSON.stringify({
          ok: true,
          file_id: "F_FAKE",
          upload_url: new URL("../upload/F_FAKE", fake.slackApiUrl).href,
        }),
      );
    } else if (call.path === "/upload/F_FAKE") {
      assert.ok(call.bytes.includes(bytes));
      response.setHeader("Content-Type", "text/plain");
      response.end("OK - 6");
    } else if (call.method === "files.completeUploadExternal") {
      response.end(JSON.stringify({ ok: true, files: [{ id: "F_FAKE" }] }));
    } else {
      response.end(JSON.stringify({ ok: false, error: "unexpected_method" }));
    }
  });
  const result = await webClient(fake).filesUploadV2({
    channel_id: "C_FAKE",
    thread_ts: "1793000000.000001",
    file: bytes,
    filename: "sample.bin",
    title: "Protocol test bytes",
  });
  assert.equal(result.files[0].files[0].id, "F_FAKE");
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].body.get("length"), "6");
  assert.equal(fake.calls[2].body.get("channel_id"), "C_FAKE");
  assert.equal(fake.calls[2].body.get("thread_ts"), "1793000000.000001");
});

test("known SDK gap: documented top-level app_rate_limited payload rejects dispatch", async () => {
  const client = new SocketModeClient({
    appToken: "xapp-fake-for-local-tests-only",
    autoReconnectEnabled: false,
    logLevel: LogLevel.ERROR,
  });
  // Deliberately probe the protected dispatcher, not a production integration seam.
  await assert.rejects(
    client.onWebSocketMessage(
      JSON.stringify({
        type: "events_api",
        envelope_id: "envelope-rate-limited",
        payload: {
          type: "app_rate_limited",
          api_app_id: "A_FAKE",
          team_id: "T_FAKE",
          minute_rate_limited: 1793145600,
        },
      }),
      false,
    ),
    TypeError,
  );
});

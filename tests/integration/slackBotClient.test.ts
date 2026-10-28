import { expect, onTestFinished, spyOn, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../fakes/slack";

const NOW = Date.parse("2026-10-27T09:00:00Z");

/** The bot client over a fake Slack and a fresh database, with a clock the test moves. */
async function connectBot({
  token,
  timeoutMs,
  status = "active",
}: {
  token?: string;
  timeoutMs?: number;
  status?: "active" | "auth_failed" | "uninstalled";
} = {}) {
  let now = NOW;
  const fake = startFakeSlack({ now: () => now });
  onTestFinished(() => fake.stop());
  const database = await openTestDatabase();
  await createStoredInstallation(database, { status });
  const authFailures: number[] = [];
  const options = {
    slackApiUrl: fake.url,
    timeoutMs,
    onAuthFailed: () => authFailures.push(now),
    now: () => now,
  };
  const bot = createBotClient(database, token ?? fake.botToken, options);
  return {
    fake,
    database,
    bot,
    authFailures,
    channel: fake.addChannel(),
    /** Another client on the same database, as after a restart. */
    restart: () => createBotClient(database, fake.botToken, options),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The bot client over a server that gives every call the answer `answer` builds. */
async function connectBotTo(answer: () => Response) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer });
  onTestFinished(() => server.stop(true));
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  const authFailures: number[] = [];
  const bot = createBotClient(database, "xoxb-test", {
    slackApiUrl: `${server.url.href}api/`,
    onAuthFailed: () => authFailures.push(NOW),
    now: () => NOW,
  });
  return { database, bot, authFailures };
}

function readAuthFailure(database: BridgeDatabase) {
  return database.read(async (sql) => {
    const [row] = await sql<{ status: string; auth_failed_at: number | null }[]>`
      SELECT status, auth_failed_at FROM installation
    `;
    return row;
  });
}

test("a call returns what Slack answered", async () => {
  const { bot } = await connectBot();

  expect(await bot.call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "ok",
    result: expect.objectContaining({ ok: true, team_id: "TFAKE", user_id: "UFAKEBOT" }),
  });
});

test("a post whose response is lost is unknown, and nothing sends it again", async () => {
  const { fake, bot, channel } = await connectBot({ timeoutMs: 50 });
  fake.failNext("chat.postMessage", { lostResponse: true });

  const posted = await bot.call("chat.postMessage", (client) =>
    client.chat.postMessage({ channel, text: "Accepted" }),
  );
  await Bun.sleep(100);

  expect(posted).toEqual({ kind: "unknown", detail: expect.any(String) });
  expect(fake.calls.filter(({ method }) => method === "chat.postMessage")).toHaveLength(1);
  expect(fake.getMessages(channel)).toHaveLength(1);
});

test("an HTTP error is unknown, and an error Slack names goes back to the caller", async () => {
  const { fake, database, bot, authFailures, channel } = await connectBot();
  const post = () =>
    bot.call("chat.postMessage", (client) => client.chat.postMessage({ channel, text: "Hello" }));

  fake.failNext("chat.postMessage", { status: 503 });
  expect(await post()).toEqual({ kind: "unknown", detail: "HTTP 503" });
  fake.failNext("chat.postMessage", { error: "internal_error", afterWrite: true });
  expect(await post()).toEqual({
    kind: "error",
    error: "internal_error",
    data: expect.objectContaining({ ok: false, error: "internal_error" }),
  });
  fake.failNext("chat.postMessage", { error: "not_in_channel" });
  expect(await post()).toMatchObject({ kind: "error", error: "not_in_channel" });

  expect(await readAuthFailure(database)).toEqual({ status: "active", auth_failed_at: null });
  expect(authFailures).toEqual([]);
});

test("an answer that isn't Slack's is unknown, and holds nothing back", async () => {
  for (const answer of [
    () =>
      new Response("<html>Sign in to this network</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    () => Response.json({ ok: false }),
  ]) {
    const { database, bot, authFailures } = await connectBotTo(answer);

    expect(await bot.call("auth.test", (client) => client.auth.test())).toEqual({
      kind: "unknown",
      detail: "unreadable response",
    });
    expect(await bot.cooldown("auth.test")).toBeNull();
    expect(await readAuthFailure(database)).toEqual({ status: "active", auth_failed_at: null });
    expect(authFailures).toEqual([]);
  }
});

test("a 429 holds back that method, and only it, until Slack's Retry-After passes", async () => {
  const { fake, bot, channel, restart, advance } = await connectBot();
  const history = (client = bot) =>
    client.call("conversations.history", (web) => web.conversations.history({ channel }));
  const historyCalls = () => fake.calls.filter(({ method }) => method === "conversations.history");

  fake.failNext("conversations.history", { retryAfter: 3 });
  expect(await history()).toEqual({ kind: "rate_limited", until: NOW + 3000 });
  expect(await history()).toEqual({ kind: "rate_limited", until: NOW + 3000 });
  expect(await history(restart())).toEqual({ kind: "rate_limited", until: NOW + 3000 });
  expect(historyCalls()).toHaveLength(1);
  expect(await bot.cooldown("conversations.history")).toBe(NOW + 3000);
  expect(await bot.call("auth.test", (client) => client.auth.test())).toMatchObject({
    kind: "ok",
  });

  advance(2999);
  expect(await history()).toMatchObject({ kind: "rate_limited" });
  advance(1);
  expect(await bot.cooldown("conversations.history")).toBeNull();
  expect(await history()).toMatchObject({ kind: "ok" });
  expect(historyCalls()).toHaveLength(2);
});

test("a shorter Retry-After never cuts short a longer wait another caller recorded", async () => {
  const { fake, database, bot, channel } = await connectBot();
  fake.failNext("chat.postMessage", { retryAfter: 1 });

  const posted = await bot.call("chat.postMessage", async (client) => {
    // Another caller's 429 asked for longer while this call was on its way.
    await database.write(
      (transaction) =>
        transaction`INSERT INTO rate_limits (method, next_attempt_at) VALUES ('chat.postMessage', ${NOW + 60_000})`,
    );
    return client.chat.postMessage({ channel, text: "Limited" });
  });

  expect(posted).toEqual({ kind: "rate_limited", until: NOW + 60_000 });
  expect(await bot.cooldown("chat.postMessage")).toBe(NOW + 60_000);
});

test("Slack limiting a call in an ok:false answer holds that method back for a minute", async () => {
  const { fake, bot, channel, advance } = await connectBot();
  const history = () =>
    bot.call("conversations.history", (client) => client.conversations.history({ channel }));
  fake.failNext("chat.postMessage", { error: "ratelimited" });
  fake.failNext("conversations.history", { error: "rate_limited" });

  expect(
    await bot.call("chat.postMessage", (client) =>
      client.chat.postMessage({ channel, text: "Limited" }),
    ),
  ).toEqual({ kind: "rate_limited", until: NOW + 60_000 });
  advance(1000);
  expect(await history()).toEqual({ kind: "rate_limited", until: NOW + 61_000 });
  expect(await history()).toEqual({ kind: "rate_limited", until: NOW + 61_000 });

  expect(fake.calls.filter(({ method }) => method === "conversations.history")).toHaveLength(1);
  expect(await bot.cooldown("chat.postMessage")).toBe(NOW + 60_000);
  expect(fake.getMessages(channel)).toEqual([]);
  expect(await bot.call("auth.test", (client) => client.auth.test())).toMatchObject({
    kind: "ok",
  });
});

test("an ok:false rate limit holds that method back for the Retry-After Slack sent with it", async () => {
  const { bot } = await connectBotTo(() =>
    Response.json({ ok: false, error: "rate_limited" }, { headers: { "Retry-After": "7" } }),
  );

  expect(await bot.call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "rate_limited",
    until: NOW + 7000,
  });
  expect(await bot.cooldown("auth.test")).toBe(NOW + 7000);
});

test("a 429 without a Retry-After the SDK can read holds that method back for a minute", async () => {
  const { fake, bot, channel } = await connectBot();
  fake.failNext("conversations.history", { status: 429 });
  const dated = await connectBotTo(() =>
    Response.json(
      { ok: false, error: "ratelimited" },
      { status: 429, headers: { "Retry-After": "Tue, 27 Oct 2026 09:05:00 GMT" } },
    ),
  );

  expect(
    await bot.call("conversations.history", (client) => client.conversations.history({ channel })),
  ).toEqual({ kind: "rate_limited", until: NOW + 60_000 });
  expect(await dated.bot.call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "rate_limited",
    until: NOW + 60_000,
  });
  expect(await dated.bot.cooldown("auth.test")).toBe(NOW + 60_000);
});

test("a rejected token puts an active installation in auth_failed, once", async () => {
  const { database, bot, authFailures, advance } = await connectBot({ token: "xoxb-revoked" });

  expect(await bot.call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "auth_failed",
    error: "invalid_auth",
  });
  advance(1000);
  expect(await bot.call("auth.test", (client) => client.auth.test())).toMatchObject({
    kind: "auth_failed",
  });

  expect(await readAuthFailure(database)).toEqual({ status: "auth_failed", auth_failed_at: NOW });
  expect(authFailures).toEqual([NOW]);
});

test("a workspace moving into an Enterprise org fails auth too", async () => {
  const { fake, database, bot, authFailures, channel } = await connectBot();
  fake.failNext("conversations.history", { error: "team_added_to_org" });

  expect(
    await bot.call("conversations.history", (client) => client.conversations.history({ channel })),
  ).toEqual({ kind: "auth_failed", error: "team_added_to_org" });
  expect(await readAuthFailure(database)).toEqual({ status: "auth_failed", auth_failed_at: NOW });
  expect(authFailures).toEqual([NOW]);
});

test("an uninstalled installation stays uninstalled when its token is rejected", async () => {
  const { database, bot, authFailures } = await connectBot({
    token: "xoxb-revoked",
    status: "uninstalled",
  });

  expect(await bot.call("auth.test", (client) => client.auth.test())).toMatchObject({
    kind: "auth_failed",
  });
  expect(await readAuthFailure(database)).toEqual({ status: "uninstalled", auth_failed_at: null });
  expect(authFailures).toEqual([]);
});

test("an error from the caller's own code isn't mistaken for Slack's", async () => {
  const { bot } = await connectBot();

  await expect(
    bot.call("auth.test", async (client) => {
      await client.auth.test();
      throw new Error("Unexpected shape.");
    }),
  ).rejects.toThrow("Unexpected shape.");
});

test("the bot token only ever goes to Slack's API URL", async () => {
  const paths = (requests: string[]) =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return Response.json({ ok: true });
      },
    });
  const slackRequests: string[] = [];
  const elsewhereRequests: string[] = [];
  const slack = paths(slackRequests);
  const elsewhere = paths(elsewhereRequests);
  onTestFinished(() => Promise.all([slack.stop(true), elsewhere.stop(true)]));
  const bot = createBotClient(await openTestDatabase(), "xoxb-test", {
    slackApiUrl: `${slack.url.href}api/`,
  });

  await bot.call("auth.test", (client) => client.apiCall(`${elsewhere.url.href}api/auth.test`));

  expect(elsewhereRequests).toEqual([]);
  expect(slackRequests).toHaveLength(1);
});

test("the SDK logs neither what a call sent nor Slack's warning, which goes back to the caller", async () => {
  const { fake, bot, channel } = await connectBot();
  const consoles = (["debug", "info", "log", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation(() => {}),
  );
  onTestFinished(() => {
    for (const spy of consoles) spy.mockRestore();
  });
  fake.failNext("chat.postMessage", { dropMetadata: true });

  const posted = await bot.call("chat.postMessage", (client) =>
    client.chat.postMessage({
      channel,
      text: "Our launch slips a week",
      metadata: { event_type: "toy_box_outbox", event_payload: { id: "outbox-1" } },
    }),
  );

  expect(posted).toEqual({
    kind: "ok",
    result: expect.objectContaining({ warning: "invalid_metadata_schema" }),
  });
  expect(consoles.flatMap((spy) => spy.mock.calls)).toEqual([]);
});

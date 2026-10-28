import { describe, expect, onTestFinished, spyOn, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import {
  startSlackSupervisor,
  STEADY_CONNECTION_MS,
  type SlackSupervisor,
  type SlackSupervisorOptions,
} from "@bridge/server/slack";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { SlackState } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import {
  refusalProblem,
  rejectedTokenProblem,
  type IdentityRefusal,
} from "@slackapi/model/identity";
import { createBotClient } from "@slackapi/server/botClient";
import { readInstallation, recordInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { defaultWakeTimings, type WakeTimings } from "@wakes/model";
import { startFakeSlack, type FakeSlack } from "../fakes/slack";
import { waitFor } from "./waitFor";

const NOW = Date.parse("2026-10-28T09:00:00Z");

/** Backoff short enough to wait out. */
const TIMINGS: WakeTimings = { ...defaultWakeTimings, retry: 20, retryLimit: 80 };

/** Backoff no test waits out. */
const STUCK: WakeTimings = { ...defaultWakeTimings, retry: 60_000, retryLimit: 60_000 };

const connected: SlackState = { connection: "connected", problem: null };

/**
 * A fake Slack and a fresh database with a link watching C-link, where supervisors start for the
 * fake's tokens. Only the test moves the clock, and `nextRead` tells it when the clock is read,
 * which is how a frame is stamped as it arrives.
 */
async function linkFakeSlack() {
  let time = NOW;
  let reading: PromiseWithResolvers<void> | undefined;
  const fake = startFakeSlack({ now: () => time });
  const stops: (() => Promise<void>)[] = [];
  // A test expecting an error passes its own onError.
  const errors: unknown[] = [];
  // Registered before the database's own cleanup, so every supervisor stops before it closes.
  onTestFinished(async () => {
    for (const stop of stops.toReversed()) await stop();
    await fake.stop();
    expect(errors).toEqual([]);
  });
  const database = await openTestDatabase();
  await createStoredLink(database, "link", { slack_channel_id: "C-link" });

  function now() {
    reading?.resolve();
    reading = undefined;
    return time;
  }

  /** Starts a supervisor as the bridge does. */
  function supervise(options: Partial<SlackSupervisorOptions> = {}) {
    const slackApiUrl = options.slackApiUrl ?? fake.url;
    const bot = createBotClient(database, fake.botToken, {
      slackApiUrl,
      now,
      onAuthFailed: (error) => supervisor.botRejected(error),
    });
    const supervisor = startSlackSupervisor(database, bot, {
      tokens: { botToken: fake.botToken, appToken: fake.appToken },
      slackApiUrl,
      onError: (error) => errors.push(error),
      now,
      timings: TIMINGS,
      reconnectDelay: 5,
      ...options,
    });
    stops.push(() => supervisor.stop());
    return { supervisor, bot };
  }

  return {
    fake,
    database,
    supervise,
    advance(ms: number) {
      time += ms;
    },
    nextRead() {
      reading = Promise.withResolvers();
      return reading.promise;
    },
  };
}

/** A person's message in C-link at `ts`, as Slack sends it. */
function post(ts: string) {
  return { type: "message", channel: "C-link", user: "U-carol", team: "TFAKE", text: "Hi", ts };
}

/** Holds every database call until the returned function releases it. */
function holdDatabase(database: BridgeDatabase) {
  const held = Promise.withResolvers<void>();
  const holding = database.read(() => held.promise);
  return async () => {
    held.resolve();
    await holding;
  };
}

function readMessages(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT ts FROM messages ORDER BY ts`);
}

function called(fake: FakeSlack, method: string) {
  return fake.calls.filter((call) => call.method === method).length;
}

function methodsCalled(fake: FakeSlack) {
  return fake.calls.map(({ method }) => method);
}

function silenceLog() {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

/** Stops `supervisor` while what it waits for is held, checking it waits until `release`. */
async function stopHeld(supervisor: SlackSupervisor, release: () => unknown) {
  let stopped = false;
  const stopping = supervisor.stop().then(() => (stopped = true));
  await Bun.sleep(50);
  expect(stopped).toBe(false);
  await release();
  await stopping;
}

const hello = { type: "hello", connection_info: { app_id: "AFAKE" } };

/**
 * A Slack whose Web API is `fake`'s, but whose connections send `frames` and keep the envelope IDs
 * they're acked. Slack's answer to `hold.method` waits for `hold.until`.
 */
function proxySlack(
  fake: FakeSlack,
  {
    frames = [hello],
    hold,
  }: { frames?: object[]; hold?: { method: string; until: Promise<void> } },
) {
  const acked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/socket") {
        return server.upgrade(request) ? undefined : new Response("Upgrade", { status: 400 });
      }
      const method = pathname.slice("/api/".length);
      const answer = await fetch(new URL(method, fake.url), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
      if (method === hold?.method) await hold.until;
      if (method !== "apps.connections.open") return answer;
      const body = (await answer.json()) as { ok: boolean; url?: string };
      if (body.ok) body.url = new URL("/socket", server.url).href.replace(/^http/, "ws");
      return Response.json(body);
    },
    websocket: {
      open(socket) {
        for (const frame of frames) socket.send(JSON.stringify(frame));
      },
      message(_, data) {
        acked.push((JSON.parse(String(data)) as { envelope_id: string }).envelope_id);
      },
    },
  });
  onTestFinished(() => server.stop(true));
  return { slackApiUrl: new URL("/api/", server.url).href, acked };
}

/** Event `id` for the fake's app and bot, framed as Slack sends it over Socket Mode. */
function eventEnvelope(id: string, event: object) {
  return {
    type: "events_api",
    envelope_id: `env-${id}`,
    accepts_response_payload: false,
    retry_attempt: 0,
    retry_reason: "",
    payload: {
      type: "event_callback",
      team_id: "TFAKE",
      api_app_id: "AFAKE",
      event_id: `Ev-${id}`,
      event_time: NOW / 1000,
      authorizations: [
        {
          enterprise_id: null,
          team_id: "TFAKE",
          user_id: "UFAKEBOT",
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      event,
    },
  };
}

describe("connecting", () => {
  test("Slack connects once the tokens are confirmed and Slack says hello, and takes what follows it", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const slack = proxySlack(link.fake, {
      frames: [
        eventEnvelope("early", post("1700000100.000100")),
        hello,
        eventEnvelope("late", post("1700000200.000100")),
      ],
    });

    const { supervisor } = link.supervise({ slackApiUrl: slack.slackApiUrl });
    expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
    expect(supervisor.workspaceUrl()).toBeNull();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    await waitFor(() => expect(slack.acked).toEqual(["env-late"]));

    expect(supervisor.workspaceUrl()).toBe("https://fake-workspace.slack.com/");
    expect(methodsCalled(link.fake)).toEqual(["auth.test", "bots.info", "apps.connections.open"]);
    // A frame before hello is left for Slack to send again.
    expect(await readMessages(link.database)).toEqual([{ ts: "1700000200.000100" }]);
    expect(log.mock.calls).toEqual([["Connected to Slack."]]);
  });

  test("Slack that can't connect yet is asked again, less often each time, saying why once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { status: 503 });
    link.fake.failNext("auth.test", { status: 503 });
    link.fake.failNext("apps.connections.open", { error: "access_denied" });
    link.fake.failNext("apps.connections.open", { status: 503 });

    const { supervisor } = link.supervise({
      timings: { ...defaultWakeTimings, retry: 50, retryLimit: 400 },
    });
    const askedAt: number[] = [];
    for (let count = 1; count <= 3; count++) {
      await waitFor(() => expect(called(link.fake, "auth.test")).toBe(count));
      askedAt.push(performance.now());
    }
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    expect(askedAt[1]! - askedAt[0]!).toBeGreaterThanOrEqual(45);
    expect(askedAt[2]! - askedAt[1]!).toBeGreaterThanOrEqual(95);
    expect(methodsCalled(link.fake)).toEqual([
      ...["auth.test", "auth.test", "auth.test", "bots.info"],
      ...["apps.connections.open", "apps.connections.open", "apps.connections.open"],
    ]);
    expect(log.mock.calls).toEqual([
      ["Can't connect to Slack. Slack didn't answer auth.test: HTTP 503."],
      ["Can't connect to Slack. Slack refused apps.connections.open with access_denied."],
      ["Can't connect to Slack. Slack didn't answer apps.connections.open: HTTP 503."],
      ["Connected to Slack."],
    ]);
    // What went wrong before the connection came up is behind it once it's lost.
    link.fake.dropConnections();
    await waitFor(() =>
      expect(supervisor.state()).toEqual({ connection: "reconnecting", problem: null }),
    );
  });

  test.each(["auth.test", "apps.connections.open"])(
    "Slack holding back %s is asked again only once the time it named is up",
    async (method) => {
      const log = silenceLog();
      const link = await linkFakeSlack();
      link.fake.failNext(method, { retryAfter: 1 });

      const { supervisor } = link.supervise();
      const problem = `Slack is holding back ${method}.`;
      await waitFor(() =>
        expect(supervisor.state()).toEqual({ connection: "connecting", problem }),
      );
      link.advance(1_000);
      await Bun.sleep(500);
      expect(called(link.fake, method)).toBe(1);

      await waitFor(() => expect(supervisor.state()).toEqual(connected), 2_000);
      expect(log.mock.calls).toEqual([
        [`Can't connect to Slack. ${problem}`],
        ["Connected to Slack."],
      ]);
    },
  );

  test("a connection Slack never says hello on is replaced, saying why once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const slack = proxySlack(link.fake, { frames: [] });

    const { supervisor } = link.supervise({ slackApiUrl: slack.slackApiUrl, helloTimeoutMs: 50 });
    const problem = "Slack didn't say hello in time.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    await waitFor(() => expect(called(link.fake, "apps.connections.open")).toBe(3));

    expect(log.mock.calls).toEqual([[`Can't connect to Slack. ${problem}`]]);
  });

  test.each([
    [
      "the installation",
      "INSERT ON installation",
      "Stopped connecting to Slack:",
      ["auth.test", "bots.info"],
    ],
    [
      "a hello",
      "UPDATE OF connected_at ON installation",
      "Stopped receiving from Slack:",
      ["auth.test", "bots.info", "apps.connections.open"],
    ],
  ])(
    "%s that can't be stored stops Slack with the error before it takes anything",
    async (_, change, stopped, methods) => {
      const log = silenceLog();
      const link = await linkFakeSlack();
      await link.database.write((transaction) =>
        transaction.unsafe(`
          CREATE TRIGGER disk_full BEFORE ${change}
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
        `),
      );

      const errors: unknown[] = [];
      const { supervisor } = link.supervise({ onError: (error) => errors.push(error) });
      await waitFor(() => expect(errors).toHaveLength(1));
      await waitFor(() => expect(link.fake.activeConnections).toBe(0));
      await Bun.sleep(TIMINGS.retryLimit * 2);

      expect(String(errors[0])).toContain("database or disk is full");
      expect(errors).toHaveLength(1);
      expect(methodsCalled(link.fake)).toEqual(methods);
      expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
      expect(log.mock.calls).toEqual([[stopped, errors[0]]]);
    },
  );
});

describe("losing the connection", () => {
  test("a lost connection is noted when it's noticed, and one that lasted reconnects at once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({ timings: STUCK });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    link.advance(STEADY_CONNECTION_MS);
    const noticed = link.nextRead();
    link.fake.dropConnections();
    // The socket reads the clock as it closes, and the hello comes a second later.
    await noticed;
    link.advance(1_000);
    await waitFor(() => expect(link.fake.connections).toHaveLength(2));
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    const lostAt = NOW + STEADY_CONNECTION_MS;
    expect(
      await link.database.read(
        (sql) => sql`SELECT connected_at, disconnected_at FROM installation`,
      ),
    ).toEqual([{ connected_at: lostAt + 1_000, disconnected_at: lostAt }]);
    link.advance(STEADY_CONNECTION_MS);
    link.fake.disconnect("refresh_requested");
    await waitFor(() => expect(link.fake.connections).toHaveLength(3));
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    expect(log.mock.calls).toEqual([
      ["Connected to Slack."],
      ["Lost the connection to Slack, so the bridge is reconnecting."],
      ["Connected to Slack."],
      ["Slack ended the connection with refresh_requested, so the bridge is reconnecting."],
      ["Connected to Slack."],
    ]);
  });

  test("connections that keep dropping soon after hello wait longer each time, until one lasts", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({
      timings: { ...defaultWakeTimings, retry: 50, retryLimit: 400 },
    });
    const openedAt: number[] = [];
    for (let count = 1; count <= 4; count++) {
      await waitFor(() => expect(link.fake.activeConnections).toBe(1));
      await waitFor(() => expect(supervisor.state()).toEqual(connected));
      openedAt.push(performance.now());
      if (count === 4) break;
      link.fake.dropConnections();
      await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    }
    const waits = openedAt.slice(1).map((at, index) => at - openedAt[index]!);
    expect(waits[0]).toBeGreaterThanOrEqual(45);
    expect(waits[1]).toBeGreaterThanOrEqual(95);
    expect(waits[2]).toBeGreaterThanOrEqual(195);

    // Once a connection lasts, losing it reconnects without waiting out the backoff it had reached.
    link.advance(STEADY_CONNECTION_MS);
    const lostAt = performance.now();
    link.fake.dropConnections();
    await waitFor(() => expect(link.fake.connections).toHaveLength(5));
    expect(performance.now() - lostAt).toBeLessThan(150);
  });
});

describe("rejected tokens", () => {
  test("a bot token Slack rejects at startup opens no connection, and is named once until a restart", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    await link.database.write((transaction) => recordInstallation(transaction, link.fake.identity));
    link.fake.failNext("auth.test", { error: "invalid_auth" });

    const { supervisor } = link.supervise();
    const problem = rejectedTokenProblem("SLACK_BOT_TOKEN", "invalid_auth");
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "auth_failed", problem }));
    await Bun.sleep(TIMINGS.retryLimit * 2);
    expect(methodsCalled(link.fake)).toEqual(["auth.test"]);
    // The bot's client and the identity check each found the rejection.
    expect(log.mock.calls).toEqual([[problem]]);

    await supervisor.stop();
    const restarted = link.supervise();
    await waitFor(() => expect(restarted.supervisor.state()).toEqual(connected));
    expect(await link.database.read(readInstallation)).toMatchObject({ status: "active" });
  });

  test("a bot token Slack rejects once connected leaves the connection up, and both rejected tokens are named", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor, bot } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    link.fake.failNext("conversations.info", { error: "token_revoked" });

    await bot.call("conversations.info", (client) =>
      client.conversations.info({ channel: "C-link" }),
    );
    const botRejected = rejectedTokenProblem("SLACK_BOT_TOKEN", "token_revoked");
    expect(supervisor.state()).toEqual({ connection: "auth_failed", problem: botRejected });
    const sent = link.fake.sendEvent(post("1700000200.000100"));
    expect(await link.fake.waitForAck(sent.envelopeId)).not.toBeNull();

    link.fake.failNext("apps.connections.open", { error: "invalid_auth" });
    link.advance(STEADY_CONNECTION_MS);
    link.fake.dropConnections();
    const appRejected = rejectedTokenProblem("SLACK_APP_TOKEN", "invalid_auth");
    await waitFor(() =>
      expect(supervisor.state()).toEqual({
        connection: "auth_failed",
        problem: `${botRejected} ${appRejected}`,
      }),
    );
    await Bun.sleep(TIMINGS.retryLimit * 2);

    expect(methodsCalled(link.fake)).toEqual([
      ...["auth.test", "bots.info", "apps.connections.open"],
      ...["conversations.info", "apps.connections.open"],
    ]);
    expect(log.mock.calls).toEqual([
      ["Connected to Slack."],
      [botRejected],
      ["Lost the connection to Slack, so the bridge is reconnecting."],
      [appRejected],
    ]);
  });

  test.each(["invalid_auth", "not_allowed_token_type", "missing_scope"])(
    "an app token Slack rejects with %s is named, and isn't tried again",
    async (error) => {
      const log = silenceLog();
      const link = await linkFakeSlack();
      link.fake.failNext("apps.connections.open", { error });

      const { supervisor } = link.supervise();
      const problem = rejectedTokenProblem("SLACK_APP_TOKEN", error);
      await waitFor(() =>
        expect(supervisor.state()).toEqual({ connection: "auth_failed", problem }),
      );
      await Bun.sleep(TIMINGS.retryLimit * 2);

      expect(called(link.fake, "apps.connections.open")).toBe(1);
      expect(log.mock.calls).toEqual([[problem]]);
    },
  );
});

describe("refusing Slack", () => {
  test("a hello naming another app closes the connection before anything is taken, and Slack stays off", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.setNextHelloAppId("A-other");

    const { supervisor } = link.supervise();
    const refusal: IdentityRefusal = { reason: "other_app", stored: "AFAKE", found: "A-other" };
    const refused: SlackState = { connection: "refused", problem: refusalProblem(refusal) };
    await waitFor(() => expect(supervisor.state()).toEqual(refused));
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    // A call finding the bot token rejected afterwards has nothing left to change.
    supervisor.botRejected("invalid_auth");
    await Bun.sleep(TIMINGS.retryLimit * 2);

    expect(supervisor.state()).toEqual(refused);
    expect(called(link.fake, "apps.connections.open")).toBe(1);
    expect(await link.database.read((sql) => sql`SELECT connected_at FROM installation`)).toEqual([
      { connected_at: null },
    ]);
    expect(log.mock.calls).toEqual([[refusalProblem(refusal)]]);
  });

  test("tokens for another workspace than the stored one turn Slack off before it connects", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    await createStoredInstallation(link.database);

    const { supervisor } = link.supervise();
    const refusal: IdentityRefusal = {
      reason: "mismatch",
      field: "teamId",
      stored: "T-home",
      found: "TFAKE",
    };
    const refused: SlackState = { connection: "refused", problem: refusalProblem(refusal) };
    await waitFor(() => expect(supervisor.state()).toEqual(refused));
    await Bun.sleep(TIMINGS.retryLimit * 2);

    expect(methodsCalled(link.fake)).toEqual(["auth.test", "bots.info"]);
    expect(log.mock.calls).toEqual([[refusalProblem(refusal)]]);
  });

  test("an uninstall closes the connection, and Slack stays off", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    const uninstall = link.fake.sendEvent({ type: "app_uninstalled" });

    const problem = refusalProblem({ reason: "uninstalled" });
    expect(await link.fake.waitForAck(uninstall.envelopeId)).not.toBeNull();
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "refused", problem }));
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    await Bun.sleep(TIMINGS.retryLimit * 2);
    expect(called(link.fake, "apps.connections.open")).toBe(1);
    expect(await link.database.read(readInstallation)).toMatchObject({ status: "uninstalled" });
    expect(log.mock.calls).toEqual([["Connected to Slack."], [problem]]);
  });
});

describe("stopping", () => {
  test("stopping closes the connection, and waits for the delivery in hand without acking it", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const release = holdDatabase(link.database);
    const arrived = link.nextRead();
    const sent = link.fake.sendEvent(post("1700000200.000100"));
    await arrived;

    await stopHeld(supervisor, async () => {
      await waitFor(() => expect(link.fake.activeConnections).toBe(0));
      await release();
    });

    expect(await readMessages(link.database)).toEqual([{ ts: "1700000200.000100" }]);
    expect(await link.fake.waitForAck(sent.envelopeId, 100)).toBeNull();
    expect(log.mock.calls).toEqual([["Connected to Slack."]]);
  });

  test("stopping while Slack is asked whose tokens these are waits for what its answer stores", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    await link.database.write((transaction) => recordInstallation(transaction, link.fake.identity));
    link.fake.failNext("auth.test", { error: "invalid_auth" });
    const answering = Promise.withResolvers<void>();
    const slack = proxySlack(link.fake, {
      hold: { method: "auth.test", until: answering.promise },
    });
    const { supervisor } = link.supervise({ slackApiUrl: slack.slackApiUrl });
    await waitFor(() => expect(called(link.fake, "auth.test")).toBe(1));

    await stopHeld(supervisor, () => answering.resolve());

    expect(await link.database.read(readInstallation)).toMatchObject({ status: "auth_failed" });
    expect(methodsCalled(link.fake)).toEqual(["auth.test"]);
  });

  test("stopping while Slack is asked for a connection waits for its answer, and connects nothing", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const answering = Promise.withResolvers<void>();
    const slack = proxySlack(link.fake, {
      hold: { method: "apps.connections.open", until: answering.promise },
    });
    const { supervisor } = link.supervise({ slackApiUrl: slack.slackApiUrl });
    await waitFor(() => expect(called(link.fake, "apps.connections.open")).toBe(1));

    await stopHeld(supervisor, () => answering.resolve());

    expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
    expect(log).not.toHaveBeenCalled();
  });

  test("stopping while waiting to ask Slack again asks nothing more", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { status: 503 });
    const { supervisor } = link.supervise({ timings: STUCK });
    await waitFor(() => expect(supervisor.state().problem).not.toBeNull());

    await supervisor.stop();

    expect(methodsCalled(link.fake)).toEqual(["auth.test"]);
  });
});

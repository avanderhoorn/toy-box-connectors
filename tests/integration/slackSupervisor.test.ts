import { describe, expect, onTestFinished, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ACK_DEADLINE_MS } from "@activity/model/receiver";
import type { BridgeDatabase } from "@bridge/server/database";
import {
  startSlackSupervisor,
  STEADY_CONNECTION_MS,
  type SlackSupervisorOptions,
} from "@bridge/server/slack";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import type { SlackState } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import {
  refusalProblem,
  rejectedTokenProblem,
  type IdentityRefusal,
} from "@slackapi/model/identity";
import { createBotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { defaultWakeTimings, type WakeTimings } from "@wakes/model";
import { startFakeSlack, type FakeSlack } from "../fakes/slack";
import { waitFor } from "./waitFor";

const NOW = Date.parse("2026-10-28T09:00:00Z");

/** Backoff short enough to wait out. */
const TIMINGS: WakeTimings = { ...defaultWakeTimings, retry: 20, retryLimit: 80 };

/** Backoff long enough to see the state the bridge waits in. */
const SLOW: WakeTimings = { ...defaultWakeTimings, retry: 300, retryLimit: 300 };

/** Backoff no test waits out. */
const STUCK: WakeTimings = { ...defaultWakeTimings, retry: 60_000, retryLimit: 60_000 };

const connected: SlackState = { connection: "connected", problem: null };

type SuperviseOptions = Partial<SlackSupervisorOptions> & {
  appToken?: string;
  slackApiUrl?: string;
  botTimeoutMs?: number;
};

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
  const filesFolder = join(createTestFolder(), "files");
  let changes = 0;

  function now() {
    reading?.resolve();
    reading = undefined;
    return time;
  }

  /** Starts a supervisor as the bridge does, noting each change and error it reports. */
  function supervise({
    appToken = fake.appToken,
    slackApiUrl = fake.url,
    botTimeoutMs,
    ...options
  }: SuperviseOptions = {}) {
    const bot = createBotClient(database, fake.botToken, {
      slackApiUrl,
      timeoutMs: botTimeoutMs,
      now,
      onAuthFailed: (error) => supervisor.botRejected(error),
    });
    const supervisor = startSlackSupervisor(database, bot, {
      tokens: { botToken: fake.botToken, appToken },
      filesFolder,
      slackApiUrl,
      onChange: () => void changes++,
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
    changes: () => changes,
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

function readReceipts(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT key, disposition FROM receipts ORDER BY key`);
}

function readGaps(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT link_id, reason, opened_at FROM coverage ORDER BY id`);
}

function readHolds(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT source_unverified_at FROM requests`);
}

function readCooldowns(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT method, next_attempt_at FROM rate_limits`);
}

function called(fake: FakeSlack, method: string) {
  return fake.calls.filter((call) => call.method === method).length;
}

function silenceLog() {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

/** How many times `line` was logged. */
function logged(log: ReturnType<typeof silenceLog>, line: string) {
  return log.mock.calls.filter(([first]) => first === line).length;
}

const hello = { type: "hello", connection_info: { app_id: "AFAKE" } };

/**
 * A Slack whose Web API is `fake`'s, but whose connections send `frames` and keep the envelope IDs
 * they're acked. Each apps.connections.open answer waits for `answering`.
 */
function proxySlack(
  fake: FakeSlack,
  {
    frames = [hello],
    answering = Promise.resolve(),
  }: { frames?: object[]; answering?: Promise<void> },
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
      const answer = await fetch(new URL(pathname.slice("/api/".length), fake.url), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
      if (pathname !== "/api/apps.connections.open") return answer;
      await answering;
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
  test("Slack is connected once the tokens are confirmed and Slack says hello", async () => {
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();

    expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
    expect(supervisor.workspaceUrl()).toBeNull();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    expect(supervisor.workspaceUrl()).toBe("https://fake-workspace.slack.com/");
    expect(link.fake.calls.map(({ method }) => method)).toEqual([
      "auth.test",
      "bots.info",
      "apps.connections.open",
    ]);
    expect(link.fake.connections).toHaveLength(1);
    expect(link.changes()).toBe(2);
  });

  test("starting holds every pending request's replies, and the first hello records the startup gap", async () => {
    const link = await linkFakeSlack();
    await createStoredRequest(link.database);

    const { supervisor } = link.supervise();
    // The supervisor reads the clock as it starts, and Slack says hello a second later.
    link.advance(1_000);
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    expect(await readHolds(link.database)).toEqual([{ source_unverified_at: NOW }]);
    expect(await readGaps(link.database)).toEqual([
      { link_id: "link", reason: "startup", opened_at: NOW + 1_000 },
    ]);
  });

  test("a frame before hello is left for Slack to send again, and what follows hello is taken", async () => {
    const link = await linkFakeSlack();
    const slack = proxySlack(link.fake, {
      frames: [
        eventEnvelope("early", post("1700000100.000100")),
        hello,
        eventEnvelope("late", post("1700000200.000100")),
      ],
    });

    link.supervise({ slackApiUrl: slack.slackApiUrl });
    await waitFor(() => expect(slack.acked).toEqual(["env-late"]));

    expect(await readReceipts(link.database)).toEqual([{ key: "Ev-late", disposition: "applied" }]);
    expect(await readMessages(link.database)).toEqual([{ ts: "1700000200.000100" }]);
  });

  test("apps.connections.open failing leaves Slack connecting, says why once, and is tried again", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("apps.connections.open", { status: 503 });
    link.fake.failNext("apps.connections.open", { status: 503 });

    const { supervisor } = link.supervise({ timings: SLOW });
    const problem = "Slack didn't answer apps.connections.open: HTTP 503.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    await waitFor(() => expect(supervisor.state()).toEqual(connected), 2_000);

    expect(called(link.fake, "apps.connections.open")).toBe(3);
    expect(log.mock.calls).toEqual([
      [`Can't connect to Slack. ${problem}`],
      ["Connected to Slack."],
    ]);
    // What went wrong before the connection came up is behind it once it's lost.
    link.fake.dropConnections();
    await waitFor(() =>
      expect(supervisor.state()).toEqual({ connection: "reconnecting", problem: null }),
    );
  });

  test("Slack refusing apps.connections.open for a reason besides the token says so until it connects", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("apps.connections.open", { error: "access_denied" });

    const { supervisor } = link.supervise({ timings: SLOW });
    const problem = "Slack refused apps.connections.open with access_denied.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
  });

  test("a connection Slack never says hello on is replaced, and the app token it took isn't named", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const slack = proxySlack(link.fake, { frames: [] });
    link.fake.failNext("apps.connections.open", { error: "invalid_auth" });

    const { supervisor } = link.supervise({
      slackApiUrl: slack.slackApiUrl,
      timings: SLOW,
      helloTimeoutMs: 50,
    });
    const rejected = rejectedTokenProblem("SLACK_APP_TOKEN", "invalid_auth");
    await waitFor(() =>
      expect(supervisor.state()).toEqual({ connection: "auth_failed", problem: rejected }),
    );
    const problem = "Slack didn't say hello in time.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    await waitFor(() => expect(called(link.fake, "apps.connections.open")).toBe(3), 2_000);

    expect(logged(log, `Can't connect to Slack. ${problem}`)).toBe(1);
  });

  test("Slack holding back apps.connections.open is asked again only once the time it named is up", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("apps.connections.open", { retryAfter: 1 });

    const { supervisor } = link.supervise();
    const problem = "Slack is holding back apps.connections.open.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    await Bun.sleep(500);
    expect(called(link.fake, "apps.connections.open")).toBe(1);

    await waitFor(() => expect(supervisor.state()).toEqual(connected), 2_000);
    expect(log).toHaveBeenCalledWith(`Can't connect to Slack. ${problem}`);
  });
});

describe("losing the connection", () => {
  test("a lost connection holds pending replies when it's noticed, and the next hello records a gap", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    await createStoredRequest(link.database);
    const changes = link.changes();

    link.advance(STEADY_CONNECTION_MS);
    const noticed = link.nextRead();
    link.fake.dropConnections();
    // The socket reads the clock as it closes, and the hello comes a second later.
    await noticed;
    link.advance(1_000);
    await waitFor(() => expect(link.fake.connections).toHaveLength(2));
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    const lostAt = NOW + STEADY_CONNECTION_MS;
    expect(await readHolds(link.database)).toEqual([{ source_unverified_at: lostAt }]);
    expect(await readGaps(link.database)).toEqual([
      { link_id: "link", reason: "startup", opened_at: NOW },
      { link_id: "link", reason: "disconnect", opened_at: lostAt + 1_000 },
    ]);
    expect(link.changes()).toBe(changes + 2);
    expect(log.mock.calls).toEqual([
      ["Lost the connection to Slack, so the bridge is reconnecting."],
      ["Connected to Slack."],
    ]);
  });

  test("Slack is reconnecting while the connection is down", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({ timings: STUCK });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    link.fake.dropConnections();

    await waitFor(() =>
      expect(supervisor.state()).toEqual({ connection: "reconnecting", problem: null }),
    );
  });

  test("Slack's disconnect frame ends the connection, and one that lasted reconnects at once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({ timings: STUCK });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    link.advance(STEADY_CONNECTION_MS);
    link.fake.disconnect("refresh_requested");

    await waitFor(() => expect(link.fake.connections).toHaveLength(2));
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    expect(log).toHaveBeenCalledWith(
      "Slack ended the connection with refresh_requested, so the bridge is reconnecting.",
    );
  });

  test("a connection whose pings go unanswered is replaced", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({ pingTimeoutMs: 100 });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));

    link.fake.setSocketResponsive(false);
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "Lost the connection to Slack, so the bridge is reconnecting.",
      ),
    );
    link.fake.setSocketResponsive(true);

    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    expect(link.fake.connections.length).toBeGreaterThan(1);
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

describe("the tokens", () => {
  test("a bot token Slack rejects at startup opens no connection until Slack takes it", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { error: "invalid_auth" });

    const { supervisor } = link.supervise({ timings: SLOW });
    const problem = rejectedTokenProblem("SLACK_BOT_TOKEN", "invalid_auth");
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "auth_failed", problem }));
    expect(called(link.fake, "apps.connections.open")).toBe(0);

    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    expect(log.mock.calls).toEqual([
      [problem],
      ["Slack accepts SLACK_BOT_TOKEN again."],
      ["Connected to Slack."],
    ]);
  });

  test("a bot token Slack rejects once connected leaves the connection up until Slack takes it again", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor, bot } = link.supervise({ timings: SLOW });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    link.fake.failNext("conversations.info", { error: "token_revoked" });
    link.fake.failNext("auth.test", { error: "token_revoked" });
    const changes = link.changes();

    await bot.call("conversations.info", (client) =>
      client.conversations.info({ channel: "C-link" }),
    );

    const problem = rejectedTokenProblem("SLACK_BOT_TOKEN", "token_revoked");
    expect(supervisor.state()).toEqual({ connection: "auth_failed", problem });
    expect(link.changes()).toBe(changes + 1);
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    expect(link.fake.connections).toEqual([expect.objectContaining({ closedAt: null })]);
    expect(await link.database.read(readInstallation)).toMatchObject({ status: "active" });
    expect(await readGaps(link.database)).toContainEqual(
      expect.objectContaining({ reason: "auth_failed" }),
    );
    expect(logged(log, problem)).toBe(1);
  });

  test("a rejection while Slack is asked about the tokens outlasts the answer already on its way", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({ timings: SLOW });
    // The bot's client reads each method's cooldown just before calling it.
    await link.nextRead();
    await link.nextRead();
    expect(link.fake.calls.map(({ method }) => method)).toEqual(["auth.test"]);

    supervisor.botRejected("invalid_auth");
    link.fake.failNext("auth.test", { error: "invalid_auth" });

    const problem = rejectedTokenProblem("SLACK_BOT_TOKEN", "invalid_auth");
    await waitFor(() => expect(called(link.fake, "auth.test")).toBe(2));
    expect(supervisor.state()).toEqual({ connection: "auth_failed", problem });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    expect(logged(log, problem)).toBe(1);
    expect(logged(log, "Slack accepts SLACK_BOT_TOKEN again.")).toBe(1);
  });

  test("Slack that can't be asked about the tokens leaves Slack connecting, and says why once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { status: 503 });
    link.fake.failNext("auth.test", { status: 503 });

    const { supervisor } = link.supervise({ timings: SLOW });
    const problem = "Slack didn't answer auth.test: HTTP 503.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    expect(called(link.fake, "apps.connections.open")).toBe(0);

    await waitFor(() => expect(supervisor.state()).toEqual(connected), 2_000);
    expect(log.mock.calls).toEqual([
      [`Can't confirm the Slack tokens yet. ${problem}`],
      ["Connected to Slack."],
    ]);
    // What went wrong before the connection came up is behind it once it's lost.
    link.fake.dropConnections();
    await waitFor(() =>
      expect(supervisor.state()).toEqual({ connection: "reconnecting", problem: null }),
    );
  });

  test("Slack that keeps failing to confirm the tokens is asked less and less often", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { status: 503 });
    link.fake.failNext("auth.test", { error: "invalid_auth" });
    link.fake.failNext("auth.test", { status: 503 });

    const { supervisor } = link.supervise({
      timings: { ...defaultWakeTimings, retry: 50, retryLimit: 400 },
    });
    const askedAt: number[] = [];
    for (let count = 1; count <= 4; count++) {
      await waitFor(() => expect(called(link.fake, "auth.test")).toBe(count));
      askedAt.push(performance.now());
    }

    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const waits = askedAt.slice(1).map((at, index) => at - askedAt[index]!);
    expect(waits[0]).toBeGreaterThanOrEqual(45);
    expect(waits[1]).toBeGreaterThanOrEqual(95);
    expect(waits[2]).toBeGreaterThanOrEqual(195);
  });

  test("Slack holding back auth.test is asked again only once the time it named is up", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { retryAfter: 1 });

    const { supervisor } = link.supervise();
    const problem = "Slack is holding back auth.test.";
    await waitFor(() => expect(supervisor.state()).toEqual({ connection: "connecting", problem }));
    link.advance(1_000);
    await Bun.sleep(500);
    expect(called(link.fake, "auth.test")).toBe(1);

    await waitFor(() => expect(supervisor.state()).toEqual(connected), 2_000);
  });

  test.each(["invalid_auth", "not_allowed_token_type", "missing_scope"])(
    "an app token Slack rejects with %s is named until Slack takes it",
    async (error) => {
      const log = silenceLog();
      const link = await linkFakeSlack();
      link.fake.failNext("apps.connections.open", { error });

      const { supervisor } = link.supervise({ timings: SLOW });
      const problem = rejectedTokenProblem("SLACK_APP_TOKEN", error);
      await waitFor(() =>
        expect(supervisor.state()).toEqual({ connection: "auth_failed", problem }),
      );

      await waitFor(() => expect(supervisor.state()).toEqual(connected));
      expect(log.mock.calls).toEqual([[problem], ["Connected to Slack."]]);
      expect(link.changes()).toBe(3);
    },
  );

  test("an app token Slack never takes is asked about again, and named once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();

    const { supervisor } = link.supervise({ appToken: "xapp-wrong" });
    await waitFor(() =>
      expect(called(link.fake, "apps.connections.open")).toBeGreaterThanOrEqual(3),
    );

    const problem = rejectedTokenProblem("SLACK_APP_TOKEN", "invalid_auth");
    expect(supervisor.state()).toEqual({ connection: "auth_failed", problem });
    expect(link.fake.connections).toEqual([]);
    expect(logged(log, problem)).toBe(1);
  });

  test("both tokens Slack rejects are named", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise({ timings: STUCK });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    link.fake.failNext("auth.test", { error: "invalid_auth" });
    link.fake.failNext("apps.connections.open", { error: "invalid_auth" });

    supervisor.botRejected("invalid_auth");
    link.advance(STEADY_CONNECTION_MS);
    link.fake.dropConnections();

    await waitFor(() =>
      expect(supervisor.state()).toEqual({
        connection: "auth_failed",
        problem: [
          rejectedTokenProblem("SLACK_BOT_TOKEN", "invalid_auth"),
          rejectedTokenProblem("SLACK_APP_TOKEN", "invalid_auth"),
        ].join(" "),
      }),
    );
  });

  test("tokens whose installation can't be stored stop Slack with the error before it connects", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    await link.database.write(
      (transaction) => transaction`
        CREATE TRIGGER disk_full BEFORE INSERT ON installation
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `,
    );

    const errors: unknown[] = [];
    link.supervise({ onError: (error) => errors.push(error) });

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).toContain("database or disk is full");
    await Bun.sleep(TIMINGS.retryLimit * 2);
    expect(errors).toHaveLength(1);
    expect(link.fake.calls.map(({ method }) => method)).toEqual(["auth.test", "bots.info"]);
    expect(log.mock.calls).toEqual([["Stopped connecting to Slack:", errors[0]]]);
  });

  test("a disk that fills as Slack starts stops it once, with the first error", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    await createStoredRequest(link.database);
    await link.database.write(async (transaction) => {
      await transaction`
        CREATE TRIGGER requests_full BEFORE UPDATE ON requests
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `;
      await transaction`
        CREATE TRIGGER installation_full BEFORE INSERT ON installation
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `;
    });

    const errors: unknown[] = [];
    const { supervisor } = link.supervise({ onError: (error) => errors.push(error) });
    // Holding the request's replies fails first, then storing the installation Slack names.
    await waitFor(() => expect(errors).toHaveLength(1));
    await supervisor.stop();

    expect(String(errors[0])).toContain("database or disk is full");
    expect(errors).toHaveLength(1);
    expect(link.fake.calls.map(({ method }) => method)).toEqual(["auth.test", "bots.info"]);
    expect(log.mock.calls).toEqual([["Stopped receiving from Slack:", errors[0]]]);
  });
});

describe("refusing Slack", () => {
  test("a hello naming another app closes the connection before anything is recorded, and Slack stays off", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    link.fake.setNextHelloAppId("A-other");

    const { supervisor } = link.supervise();
    const refusal: IdentityRefusal = { reason: "other_app", stored: "AFAKE", found: "A-other" };
    const refused: SlackState = { connection: "refused", problem: refusalProblem(refusal) };
    await waitFor(() => expect(supervisor.state()).toEqual(refused));
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    await Bun.sleep(TIMINGS.retryLimit * 2);

    expect(supervisor.state()).toEqual(refused);
    expect(called(link.fake, "apps.connections.open")).toBe(1);
    expect(await readGaps(link.database)).toEqual([]);
    expect(log.mock.calls).toEqual([[refusalProblem(refusal)]]);
    expect(link.changes()).toBe(2);

    // A call finding the bot token rejected afterwards has nothing left to change.
    supervisor.botRejected("invalid_auth");
    await Bun.sleep(TIMINGS.retryLimit * 2);
    expect(supervisor.state()).toEqual(refused);
    expect(called(link.fake, "auth.test")).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(link.changes()).toBe(2);
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
    await waitFor(() =>
      expect(supervisor.state()).toEqual({
        connection: "refused",
        problem: refusalProblem(refusal),
      }),
    );
    await Bun.sleep(TIMINGS.retryLimit * 2);

    expect(link.fake.calls.map(({ method }) => method)).toEqual(["auth.test", "bots.info"]);
    expect(log.mock.calls).toEqual([[refusalProblem(refusal)]]);
  });

  test("an uninstall closes the connection, and Slack stays off", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const changes = link.changes();

    const uninstall = link.fake.sendEvent({ type: "app_uninstalled" });

    const refused: SlackState = {
      connection: "refused",
      problem: refusalProblem({ reason: "uninstalled" }),
    };
    expect(await link.fake.waitForAck(uninstall.envelopeId)).not.toBeNull();
    await waitFor(() => expect(supervisor.state()).toEqual(refused));
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    await Bun.sleep(TIMINGS.retryLimit * 2);
    expect(called(link.fake, "apps.connections.open")).toBe(1);
    expect(await link.database.read(readInstallation)).toMatchObject({ status: "uninstalled" });
    expect(link.changes()).toBe(changes + 2);
  });
});

describe("taking deliveries", () => {
  test("an event is acked once what it changed has committed, and not before", async () => {
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const release = holdDatabase(link.database);
    const arrived = link.nextRead();

    const sent = link.fake.sendEvent(post("1700000200.000100"), { eventId: "Ev-1" });
    await arrived;
    expect(await link.fake.waitForAck(sent.envelopeId, 100)).toBeNull();
    await release();

    expect(await link.fake.waitForAck(sent.envelopeId)).not.toBeNull();
    expect(await readReceipts(link.database)).toEqual([{ key: "Ev-1", disposition: "applied" }]);
    expect(await readMessages(link.database)).toEqual([{ ts: "1700000200.000100" }]);
  });

  test("an event stored too late isn't acked, and Slack's redelivery is acked and stored once", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const release = holdDatabase(link.database);
    const arrived = link.nextRead();

    const sent = link.fake.sendEvent(post("1700000200.000100"), { eventId: "Ev-1" });
    await arrived;
    link.advance(ACK_DEADLINE_MS + 1);
    await release();
    expect(await link.fake.waitForAck(sent.envelopeId, 100)).toBeNull();
    link.fake.redeliver(sent.envelopeId);

    expect(await link.fake.waitForAck(sent.envelopeId)).not.toBeNull();
    expect(link.fake.acks).toHaveLength(1);
    expect(await readReceipts(link.database)).toEqual([{ key: "Ev-1", disposition: "applied" }]);
    expect(await readMessages(link.database)).toEqual([{ ts: "1700000200.000100" }]);
    expect(log).toHaveBeenCalledWith(
      "Stored a delivery from Slack too late to ack it, so Slack will resend it.",
    );
  });

  test("an event Slack sends again after its ack is acked and stored once", async () => {
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const message = post("1700000200.000100");

    const first = link.fake.sendEvent(message, { eventId: "Ev-1" });
    expect(await link.fake.waitForAck(first.envelopeId)).not.toBeNull();
    const again = link.fake.sendEvent(message, { eventId: "Ev-1" });

    expect(await link.fake.waitForAck(again.envelopeId)).not.toBeNull();
    expect(await readReceipts(link.database)).toEqual([{ key: "Ev-1", disposition: "applied" }]);
    expect(await readMessages(link.database)).toEqual([{ ts: message.ts }]);
  });

  test("an event that can't be stored isn't acked, and closes the connection with the error", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const errors: unknown[] = [];
    const { supervisor } = link.supervise({ onError: (error) => errors.push(error) });
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    await link.database.write(
      (transaction) => transaction`
        CREATE TRIGGER disk_full BEFORE INSERT ON receipts
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `,
    );

    const sent = [
      link.fake.sendEvent(post("1700000200.000100")),
      link.fake.sendEvent(post("1700000300.000100")),
    ];

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).toContain("database or disk is full");
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    await Bun.sleep(TIMINGS.retryLimit * 2);
    for (const { envelopeId } of sent) {
      expect(await link.fake.waitForAck(envelopeId, 0)).toBeNull();
    }
    expect(errors).toHaveLength(1);
    expect(await readMessages(link.database)).toEqual([]);
    expect(called(link.fake, "apps.connections.open")).toBe(1);
    expect(log.mock.calls).toEqual([["Stopped receiving from Slack:", errors[0]]]);
  });

  test("a hello whose gap can't be stored takes nothing, and closes the connection with the error", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    await link.database.write(
      (transaction) => transaction`
        CREATE TRIGGER disk_full BEFORE INSERT ON coverage
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `,
    );

    const errors: unknown[] = [];
    const { supervisor } = link.supervise({ onError: (error) => errors.push(error) });

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).toContain("database or disk is full");
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    await Bun.sleep(TIMINGS.retryLimit * 2);
    expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
    expect(called(link.fake, "apps.connections.open")).toBe(1);
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
    const sent = link.fake.sendEvent(post("1700000200.000100"), { eventId: "Ev-1" });
    await arrived;

    let stopped = false;
    const stopping = supervisor.stop().then(() => (stopped = true));
    await waitFor(() => expect(link.fake.activeConnections).toBe(0));
    expect(stopped).toBe(false);
    await release();
    await stopping;

    expect(await readReceipts(link.database)).toEqual([{ key: "Ev-1", disposition: "applied" }]);
    expect(await link.fake.waitForAck(sent.envelopeId, 100)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  test("an uninstall in hand when the bridge stops is stored, and refuses Slack once it starts again", async () => {
    const log = silenceLog();
    const link = await linkFakeSlack();
    const { supervisor } = link.supervise();
    await waitFor(() => expect(supervisor.state()).toEqual(connected));
    const release = holdDatabase(link.database);
    const arrived = link.nextRead();
    link.fake.sendEvent({ type: "app_uninstalled" });
    await arrived;

    const stopping = supervisor.stop();
    await release();
    await stopping;

    expect(await link.database.read(readInstallation)).toMatchObject({ status: "uninstalled" });
    expect(log).not.toHaveBeenCalled();
    const again = link.supervise();
    await waitFor(() =>
      expect(again.supervisor.state()).toEqual({
        connection: "refused",
        problem: refusalProblem({ reason: "uninstalled" }),
      }),
    );
    expect(called(link.fake, "apps.connections.open")).toBe(1);
  });

  test("stopping while Slack is asked about the tokens waits for what its answer stores, and connects nothing", async () => {
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { retryAfter: 30 });
    const { supervisor } = link.supervise();
    // The bot's client reads auth.test's cooldown just before calling it.
    await link.nextRead();
    expect(link.fake.calls).toEqual([]);
    const release = holdDatabase(link.database);
    await waitFor(() => expect(link.fake.calls).toHaveLength(1));

    let stopped = false;
    const stopping = supervisor.stop().then(() => (stopped = true));
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    await release();
    await stopping;

    expect(await readCooldowns(link.database)).toEqual([
      { method: "auth.test", next_attempt_at: NOW + 30_000 },
    ]);
    expect(link.fake.calls.map(({ method }) => method)).toEqual(["auth.test"]);
    expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
  });

  test("stopping while waiting to ask Slack about the tokens again asks nothing more", async () => {
    silenceLog();
    const link = await linkFakeSlack();
    link.fake.failNext("auth.test", { status: 503 });
    const { supervisor } = link.supervise({ timings: STUCK });
    await waitFor(() => expect(supervisor.state().problem).not.toBeNull());

    await supervisor.stop();

    expect(link.fake.calls.map(({ method }) => method)).toEqual(["auth.test"]);
  });

  test("stopping while Slack is asked for a connection waits for its answer, and takes nothing", async () => {
    const link = await linkFakeSlack();
    const answering = Promise.withResolvers<void>();
    const slack = proxySlack(link.fake, { answering: answering.promise });
    const { supervisor } = link.supervise({ slackApiUrl: slack.slackApiUrl });
    await waitFor(() => expect(called(link.fake, "apps.connections.open")).toBe(1));

    let stopped = false;
    const stopping = supervisor.stop().then(() => (stopped = true));
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    answering.resolve();
    await stopping;

    expect(await readGaps(link.database)).toEqual([]);
    expect(supervisor.state()).toEqual({ connection: "connecting", problem: null });
  });
});

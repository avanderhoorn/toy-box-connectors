import { describe, expect, onTestFinished, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { APPLY_VERIFY_MS, APPROVE_ACTION_ID, type Approval } from "@links/model/approvals";
import type { SetupRequest } from "@links/model/setup";
import { startApplier, type ApplierTimings } from "@links/server/apply";
import { readApproval, recordCardPosted, takeClick } from "@links/server/approvals";
import { createFactsReader, type FactsReader } from "@links/server/facts";
import { changeSetup } from "@links/server/setup";
import { createStoredApproval, createStoredLink } from "@links/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../fakes/slack";
import { startFakeToyBox } from "../fakes/toybox";
import { waitFor } from "./waitFor";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const TIMINGS: ApplierTimings = { retry: 50, retryLimit: 100 };
const REQUESTS_ROUTINE = {
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox` and answer what's waiting.",
};

/** A full member of the installation's workspace, as users.info shows them. */
function member(id: string) {
  return {
    id,
    team_id: "T-home",
    real_name: `${id} Person`,
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
  };
}

function allow(userId: string): SetupRequest {
  return { action: "allow", userIds: [userId] };
}

/**
 * A fake Toy Box channel whose owner just posted, linked to C-link, a private channel of the fake
 * Slack's workspace with the owner and the bot in it, in a fresh database. U-carol and U-dave are
 * full members. The clock starts at NOW and runs in real time, because the applier waits on real
 * timers.
 */
async function linkFakeChannel() {
  const offset = NOW - Date.now();
  const now = () => Date.now() + offset;
  // The fake's workspace and app are the stored installation's.
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  const toyBox = startFakeToyBox({ now });
  const stops: (() => Promise<void>)[] = [];
  // Registered before the database's own cleanup, so everything stops before it closes.
  onTestFinished(async () => {
    for (const stop of stops.toReversed()) await stop();
    await toyBox.stop();
    await slack.stop();
  });
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  toyBox.postOwnerMessage(channelId, "Let Carol and Dave ask you things in #release-eng.");
  await createStoredLink(database, "link", {
    toybox_channel_id: channelId,
    requests_routine_id: routine.id,
  });
  slack.addChannel({
    id: "C-link",
    name: "release-eng",
    is_private: true,
    members: ["U-bot", "U-owner"],
  });
  slack.setUser(member("U-carol"));
  slack.setUser(member("U-dave"));
  const bot = createBotClient(database, slack.botToken, { slackApiUrl: slack.url, now });
  const reader = createFactsReader(bot, new URL(toyBox.url));
  const changes: number[] = [];
  const errors: unknown[] = [];
  let cards = 0;

  /**
   * Has the lead propose `request` at `proposedAt`, posts its card and has the owner approve it
   * at `clickedAt`, as the receiver does before the ack. Returns the approval as it's stored then.
   */
  async function approve(
    request: SetupRequest,
    {
      proposedAt = now(),
      clickedAt = proposedAt,
    }: { proposedAt?: number; clickedAt?: number } = {},
  ): Promise<Approval> {
    const caller = { role: "lead", channelId } as const;
    const outcome = await changeSetup(database, reader, caller, request, proposedAt);
    if (outcome.kind !== "proposed") throw new Error(`Setup was ${outcome.kind}, not a proposal.`);
    const cardTs = `1000.${String(++cards).padStart(6, "0")}`;
    return database.write(async (transaction) => {
      await recordCardPosted(transaction, outcome.approval.id, cardTs);
      const click = approveClick(outcome.approval, cardTs);
      expect(await takeClick(transaction, click, clickedAt)).toMatchObject({ state: "approved" });
      return (await readApproval(transaction, outcome.approval.id))!;
    });
  }

  /**
   * Starts an applier as the bridge does, noting each change it reports and each error it stops
   * on. `attempts` holds when each of its attempts began reading, and `wrap` stands between it
   * and the reader.
   */
  function startApplying({
    timings = TIMINGS,
    wrap = (reader) => reader,
  }: { timings?: ApplierTimings; wrap?: (reader: FactsReader) => FactsReader } = {}) {
    const attempts: number[] = [];
    const noted: FactsReader = {
      ...reader,
      readToyBox: (toyboxChannelId, signal) => {
        attempts.push(now());
        return reader.readToyBox(toyboxChannelId, signal);
      },
    };
    const applier = startApplier(database, wrap(noted), {
      onChange: () => changes.push(now()),
      onError: (error) => errors.push(error),
      now,
      timings,
    });
    stops.push(() => applier.stop());
    return { applier, attempts };
  }

  return { slack, toyBox, database, now, changes, errors, approve, startApplying };
}

/** The owner's click on Approve on `approval`'s card, posted at `cardTs`, as Slack sends it. */
function approveClick(approval: Approval, cardTs: string) {
  return {
    type: "block_actions",
    api_app_id: "A-app",
    team: { id: "T-home", domain: "home" },
    user: { id: "U-owner", username: "owner", team_id: "T-home" },
    trigger_id: "1.2.3",
    container: {
      type: "message",
      message_ts: cardTs,
      channel_id: approval.card.channelId,
      is_ephemeral: false,
    },
    actions: [
      {
        type: "button",
        action_id: APPROVE_ACTION_ID,
        block_id: "decide",
        value: approval.id,
        action_ts: "1000.900000",
      },
    ],
  };
}

async function readState(database: BridgeDatabase, approval: Approval) {
  const stored = await database.read((sql) => readApproval(sql, approval.id));
  return stored && { state: stored.state, staleReason: stored.staleReason };
}

/** Whom the link allows. */
async function readAllowed(database: BridgeDatabase) {
  const rows = await database.read(
    (sql) => sql<{ user_id: string }[]>`SELECT user_id FROM allowlist ORDER BY user_id`,
  );
  return rows.map((row) => row.user_id);
}

/** The card items queued for `approval`, oldest first. */
async function readCardItems(database: BridgeDatabase, approval: Approval) {
  return [
    ...(await database.read(
      (sql) => sql`
        SELECT phase, state FROM outbox
        WHERE kind = 'card' AND approval_id = ${approval.id} ORDER BY number
      `,
    )),
  ];
}

async function readInstallationStatus(database: BridgeDatabase) {
  const [installation] = await database.read(
    (sql) => sql<{ status: string }[]>`SELECT status FROM installation`,
  );
  return installation!.status;
}

/** A pending card, whose hour is up at `expiresAt`. */
function storePending(database: BridgeDatabase, number: number, expiresAt: number) {
  return createStoredApproval(database, {
    id: `approval-${number}`,
    number,
    createdAt: expiresAt - 60 * 60_000,
    expiresAt,
  });
}

const applied = { state: "applied", staleReason: null } as const;

describe("applying what the owner approved", () => {
  test("a change approved before a crash applies when the applier starts, and its card is updated", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));

    world.startApplying();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual(applied);
    expect(await readAllowed(world.database)).toEqual(["U-carol"]);
    // The post, the decision's edit it replaced, and the edit that says it applied.
    expect(await readCardItems(world.database, approval)).toEqual([
      { phase: "post", state: "queued" },
      { phase: "update", state: "superseded" },
      { phase: "update", state: "queued" },
    ]);
    expect(world.errors).toEqual([]);
  });

  test("a change approved while the applier runs applies once it's told of the click", async () => {
    const world = await linkFakeChannel();
    const { applier } = world.startApplying();
    const approval = await world.approve(allow("U-carol"));

    applier.reconsider();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual(applied);
  });

  test("a change approved during a pass gets a pass of its own as soon as that one ends", async () => {
    const world = await linkFakeChannel();
    const first = await world.approve(allow("U-carol"));
    const held = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const { applier, attempts } = world.startApplying({
      wrap: (reader) => ({
        ...reader,
        readToyBox: async (toyboxChannelId, signal) => {
          reading.resolve();
          await held.promise;
          return reader.readToyBox(toyboxChannelId, signal);
        },
      }),
    });
    await reading.promise;
    const second = await world.approve(allow("U-dave"));

    applier.reconsider();
    applier.reconsider();
    held.resolve();

    await waitFor(() => expect(world.changes).toHaveLength(2));
    expect(await readState(world.database, first)).toEqual(applied);
    expect(await readState(world.database, second)).toEqual(applied);
    expect(await readAllowed(world.database)).toEqual(["U-carol", "U-dave"]);
    // One read for each, however many times the applier was told.
    expect(attempts).toHaveLength(2);
  });

  test("a channel made public since the click leaves the change stale, and its card says so", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    world.slack.addChannel({ id: "C-link", name: "release-eng", members: ["U-bot", "U-owner"] });

    world.startApplying();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual({
      state: "stale",
      staleReason: "audience_changed",
    });
    expect(await readAllowed(world.database)).toEqual([]);
    expect((await readCardItems(world.database, approval)).at(-1)).toEqual({
      phase: "update",
      state: "queued",
    });
  });
});

describe("cards whose hour is up", () => {
  test("one whose hour ran out before the applier started expires at once, and one pending expires when its hour is up", async () => {
    const world = await linkFakeChannel();
    const lapsed = await storePending(world.database, 1, world.now() - 1);
    const pending = await storePending(world.database, 2, world.now() + 200);

    world.startApplying();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, lapsed)).toEqual({
      state: "expired",
      staleReason: null,
    });
    expect(await readState(world.database, pending)).toEqual({
      state: "pending",
      staleReason: null,
    });
    await waitFor(() => expect(world.changes).toHaveLength(2));
    expect(await readState(world.database, pending)).toEqual({
      state: "expired",
      staleReason: null,
    });
    expect(world.changes[1]! - world.changes[0]!).toBeGreaterThanOrEqual(150);
  });
});

describe("a read that proves nothing", () => {
  test("is tried again sooner at first, then no further apart than the limit", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    world.toyBox.refuseStreams(503);

    const { attempts } = world.startApplying();

    await waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(5));
    world.toyBox.acceptStreams();
    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual(applied);
    const waits = attempts.slice(1, 5).map((at, index) => at - attempts[index]!);
    // 50 ms, doubled to 100 ms, and then held at the 100 ms limit.
    expect(waits[0]).toBeGreaterThanOrEqual(45);
    expect(waits[1]).toBeGreaterThanOrEqual(95);
    expect(waits[2]).toBeGreaterThanOrEqual(95);
    expect(waits[3]).toBeLessThan(300);
  });

  test("Slack holding a method back puts the next try off until when Slack said", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    world.slack.failNext("conversations.info", { retryAfter: 1 });

    const { applier, attempts } = world.startApplying();
    await waitFor(() => expect(attempts).toHaveLength(1));
    await Bun.sleep(100);
    // A pass for something else leaves it waiting.
    applier.reconsider();
    await Bun.sleep(100);
    expect(attempts).toHaveLength(1);

    await waitFor(() => expect(world.changes).toHaveLength(1), 3_000);
    expect(await readState(world.database, approval)).toEqual(applied);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(990);
  });

  test("one still unverified when 15 minutes have passed since the click goes stale then, however long its next wait", async () => {
    const world = await linkFakeChannel();
    const clickedAt = world.now() - APPLY_VERIFY_MS + 300;
    const approval = await world.approve(allow("U-carol"), {
      proposedAt: clickedAt - 60_000,
      clickedAt,
    });
    world.toyBox.refuseStreams(503);

    world.startApplying({ timings: { retry: 10_000, retryLimit: 10_000 } });

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual({
      state: "stale",
      staleReason: "not_verified",
    });
  });

  test("one that can't be checked doesn't hold up the next", async () => {
    const world = await linkFakeChannel();
    const carol = await world.approve(allow("U-carol"));
    const dave = await world.approve(allow("U-dave"));
    world.slack.failNext("users.info", { status: 503 });

    world.startApplying();

    await waitFor(() => expect(world.changes).toHaveLength(2));
    const appliedAt = async (approval: Approval) =>
      (await world.database.read((sql) => readApproval(sql, approval.id)))!.appliedAt!;
    expect(await appliedAt(dave)).toBeLessThan(await appliedAt(carol));
  });
});

describe("while Slack isn't connected", () => {
  test("a change Slack rejects the token for waits without a read until it's connected again", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    world.slack.failNext("conversations.info", { error: "invalid_auth" });

    const { applier, attempts } = world.startApplying();

    await waitFor(async () =>
      expect(await readInstallationStatus(world.database)).toBe("auth_failed"),
    );
    // Well past the next try, which found the bridge disconnected and read nothing.
    await Bun.sleep(300);
    expect(attempts).toHaveLength(1);
    expect(await readState(world.database, approval)).toEqual({
      state: "approved",
      staleReason: null,
    });

    await world.database.write(
      (transaction) => transaction`UPDATE installation SET status = 'active'`,
    );
    applier.reconsider();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual(applied);
    expect(attempts).toHaveLength(2);
  });

  test("backing off starts over once it's connected again", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    world.toyBox.refuseStreams(503);
    let reads = 0;

    const { applier, attempts } = world.startApplying({
      timings: { retry: 100, retryLimit: 1_000 },
      wrap: (reader) => ({
        ...reader,
        readToyBox: async (toyboxChannelId, signal) => {
          const read = await reader.readToyBox(toyboxChannelId, signal);
          // Slack rejects the token during the second read, which proves nothing either.
          if (++reads === 2) {
            await world.database.write(
              (transaction) => transaction`UPDATE installation SET status = 'auth_failed'`,
            );
          }
          return read;
        },
      }),
    });

    await waitFor(() => expect(attempts).toHaveLength(2));
    // Well past the next try, 200 ms on, which found the bridge disconnected and read nothing.
    await Bun.sleep(400);
    expect(attempts).toHaveLength(2);
    await world.database.write(
      (transaction) => transaction`UPDATE installation SET status = 'active'`,
    );
    applier.reconsider();
    await waitFor(() => expect(attempts).toHaveLength(3));
    world.toyBox.acceptStreams();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual(applied);
    // 100 ms, as after the first read, rather than the 400 ms a third read in a row would wait.
    expect(attempts[3]! - attempts[2]!).toBeGreaterThanOrEqual(95);
    expect(attempts[3]! - attempts[2]!).toBeLessThan(300);
  });

  test("a change Slack stays disconnected for goes stale when its 15 minutes are up, unread", async () => {
    const world = await linkFakeChannel();
    const clickedAt = world.now() - APPLY_VERIFY_MS + 300;
    const approval = await world.approve(allow("U-carol"), {
      proposedAt: clickedAt - 60_000,
      clickedAt,
    });
    await world.database.write(
      (transaction) => transaction`UPDATE installation SET status = 'auth_failed'`,
    );

    const { attempts } = world.startApplying();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual({
      state: "stale",
      staleReason: "not_verified",
    });
    expect(attempts).toEqual([]);
  });
});

describe("stopping", () => {
  test("abandons a read in flight, leaving the change approved for the next start to apply", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    world.slack.failNext("conversations.info", { lostResponse: true });
    const proposed = world.slack.calls.length;
    let reads = 0;
    const { applier } = world.startApplying({
      wrap: (reader) => ({
        ...reader,
        readSlack: async (needed, ownerIds, signal) => {
          const read = await reader.readSlack(needed, ownerIds, signal);
          reads += 1;
          return read;
        },
      }),
    });
    await waitFor(() =>
      expect(world.slack.calls.slice(proposed).map((call) => call.method)).toContain(
        "conversations.info",
      ),
    );

    await applier.stop();

    // Stopping waits for the read it abandoned, so nothing is left running.
    expect(reads).toBe(1);
    applier.reconsider();
    await Bun.sleep(100);
    expect(await readState(world.database, approval)).toEqual({
      state: "approved",
      staleReason: null,
    });
    expect(world.changes).toEqual([]);

    world.startApplying();

    await waitFor(() => expect(world.changes).toHaveLength(1));
    expect(await readState(world.database, approval)).toEqual(applied);
  });

  test("a storage error stops the applier with nothing applied, and is reported", async () => {
    const world = await linkFakeChannel();
    const approval = await world.approve(allow("U-carol"));
    await world.database.write(
      (transaction) => transaction`
        CREATE TRIGGER fail_apply BEFORE UPDATE OF state ON approvals
        BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
      `,
    );

    world.startApplying();

    await waitFor(() => expect(world.errors).toHaveLength(1));
    expect(String(world.errors[0])).toContain("disk I/O error");
    expect(await readState(world.database, approval)).toEqual({
      state: "approved",
      staleReason: null,
    });
    expect(await readAllowed(world.database)).toEqual([]);
    expect(world.changes).toEqual([]);
  });
});

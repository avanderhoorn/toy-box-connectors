import { afterAll, beforeAll, expect, onTestFinished, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { startToyBoxClient } from "@toybox/server";
import type { WakeTimings } from "@wakes/model";
import { startWakeScheduler, type WakeScheduler } from "@wakes/server";
import { readWakeBlock, recordInbox } from "@wakes/server/database";
import { startFakeToyBox } from "../fakes/toybox";
import { waitFor } from "./waitFor";

// Tuesday 9:00 in Los Angeles, where publication schedules run in these tests.
const NOW = Date.parse("2026-10-27T16:00:00Z");
const REQUESTS_ROUTINE = {
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox` and answer what's waiting.",
};
const TIMINGS: WakeTimings = {
  debounce: 100,
  debounceLimit: 300,
  steerAfter: 500,
  settle: 30,
  backoff: [150, 300, 450],
  remindSeen: 200,
  remindInProgress: 400,
  retry: 60,
  retryLimit: 240,
  catchUpAfter: 100,
};

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

/**
 * A fake Toy Box channel with a requests routine, linked in a fresh database. The clock starts at
 * `start` and runs in real time, because the scheduler waits on real timers.
 */
async function linkFakeChannel({
  provider,
  start = NOW,
}: { provider?: string; start?: number } = {}) {
  const offset = start - Date.now();
  const now = () => Date.now() + offset;
  const toyBox = startFakeToyBox({ now });
  const stops: (() => Promise<void>)[] = [];
  // Registered before the database's own cleanup, so everything stops before it closes.
  onTestFinished(async () => {
    for (const stop of stops.toReversed()) await stop();
    await toyBox.stop();
  });
  const database = await openTestDatabase();
  const channelId = toyBox.addChannel({ provider });
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  await createStoredLink(database, "link", {
    toybox_channel_id: channelId,
    requests_routine_id: routine.id,
  });
  const errors: unknown[] = [];

  /** Follows the channel, then starts the scheduler, as the bridge does. */
  async function startWaking() {
    let scheduler: WakeScheduler | undefined;
    const client = startToyBoxClient(database, {
      origin: new URL(toyBox.url),
      onChange: () => scheduler?.reconsider(),
      onError: (error) => errors.push(error),
      now,
      timings: TIMINGS,
      reconnectDelay: 10,
    });
    stops.push(() => client.stop());
    await client.followLinks();
    await waitFor(() => expect(client.view(channelId).connected).toBe(true));
    scheduler = startWakeScheduler(database, client, {
      onError: (error) => errors.push(error),
      now,
      timings: TIMINGS,
    });
    stops.push(() => scheduler.stop());
    return { client, scheduler };
  }

  return { toyBox, database, channelId, routine, now, errors, startWaking };
}

let stored = 0;

/** Stores a request that changed at `at`, as intake does before it asks for a new decision. */
function storeRequest(database: BridgeDatabase, at: number, columns: Record<string, unknown> = {}) {
  stored += 1;
  const ts = `1700000000.${String(stored).padStart(6, "0")}`;
  const row = {
    link_id: "link",
    channel_id: "C-link",
    root_ts: ts,
    source_ts: ts,
    requester_user_id: "U-asker",
    reason: "mention",
    state: "open",
    input_hash: "hash",
    created_at: at,
    changed_at: at,
    expires_at: at + 7 * 24 * 60 * 60_000,
    ...columns,
  };
  return database.write(async (transaction) => {
    const [{ id }] = await transaction<{ id: number }[]>`
      INSERT INTO requests ${transaction(row)} RETURNING id
    `;
    return id;
  });
}

type StoredWake = { kind: string; approval_id: string | null; outcome: string; at: number };

/** The wakes the scheduler recorded, oldest first. */
function readWakes(database: BridgeDatabase): Promise<StoredWake[]> {
  return database.read(async (sql) => [
    ...(await sql<StoredWake[]>`SELECT kind, approval_id, outcome, at FROM wakes ORDER BY id`),
  ]);
}

async function readOutcomes(database: BridgeDatabase) {
  return (await readWakes(database)).map(({ kind, outcome }) => ({ kind, outcome }));
}

function readBlock(database: BridgeDatabase) {
  return database.read((sql) => readWakeBlock(sql, "link"));
}

test("a burst of requests wakes the lead once, after the latest has settled", async () => {
  const { toyBox, database, routine, now, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();
  const changes: number[] = [];

  for (let count = 0; count < 3; count += 1) {
    changes.push(now());
    await storeRequest(database, changes.at(-1)!);
    scheduler.reconsider();
    await Bun.sleep(10);
  }

  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  expect(toyBox.runs[0]).toMatchObject({ routineId: routine.id, by: "api" });
  expect(toyBox.runs[0]!.at).toBeGreaterThanOrEqual(changes.at(-1)! + TIMINGS.debounce);
  await Bun.sleep(TIMINGS.backoff[0]);
  expect(toyBox.runs).toHaveLength(1);
  expect(await readOutcomes(database)).toEqual([{ kind: "requests", outcome: "ran" }]);
});

test("a wake the lead ignores is repeated on the backoff, then stalls until a request is new", async () => {
  const { toyBox, database, channelId, now, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();
  await waitFor(() => expect(scheduler.decision("link")).toEqual({ kind: "idle" }));
  await storeRequest(database, now());
  scheduler.reconsider();

  for (const count of [1, 2, 3, 4]) {
    await waitFor(() => expect(toyBox.runs).toHaveLength(count));
    toyBox.finishTurn(channelId);
  }
  const at = toyBox.runs.map((run) => run.at);
  for (const [index, backoff] of TIMINGS.backoff.entries()) {
    expect(at[index + 1]! - at[index]!).toBeGreaterThanOrEqual(backoff);
  }
  await Bun.sleep(TIMINGS.backoff[2] + 100);
  expect(toyBox.runs).toHaveLength(4);
  expect(scheduler.decision("link")).toEqual({ kind: "stalled" });

  await storeRequest(database, now());
  scheduler.reconsider();
  await waitFor(() => expect(toyBox.runs).toHaveLength(5));
});

test("a lead mid-turn is steered once the request has waited a while", async () => {
  const { toyBox, database, channelId, now, startWaking } = await linkFakeChannel();
  const { client, scheduler } = await startWaking();
  toyBox.startTurn(channelId);
  await waitFor(() => expect(client.view(channelId).leadWorking).toBe(true));

  const changedAt = now();
  await storeRequest(database, changedAt);
  scheduler.reconsider();

  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  expect(toyBox.runs[0]!.at).toBeGreaterThanOrEqual(changedAt + TIMINGS.steerAfter);
});

test("a turn that read inbox after the request changed is left to finish", async () => {
  const { toyBox, database, channelId, now, startWaking } = await linkFakeChannel();
  const { client, scheduler } = await startWaking();
  toyBox.startTurn(channelId);
  await waitFor(() => expect(client.view(channelId).leadWorking).toBe(true));
  await storeRequest(database, now());
  await database.write((transaction) => recordInbox(transaction, "link", now()));
  scheduler.reconsider();

  await Bun.sleep(TIMINGS.steerAfter + 150);
  expect(toyBox.runs).toEqual([]);

  // The request is still open, as when more wait than one inbox serves.
  toyBox.finishTurn(channelId);
  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
});

test("an idle lead is reminded once per touch, and never about a held request", async () => {
  const { toyBox, database, channelId, now, startWaking } = await linkFakeChannel();
  const seenAt = now();
  const quiet = await storeRequest(database, seenAt, { state: "seen", seen_at: seenAt });
  const held = await storeRequest(database, seenAt, {
    state: "seen",
    seen_at: seenAt,
    held_at: seenAt,
    hold_reason: "Waiting on the release date.",
  });

  await startWaking();

  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  expect(toyBox.runs[0]!.at).toBeGreaterThanOrEqual(seenAt + TIMINGS.remindSeen);
  toyBox.finishTurn(channelId);
  await waitFor(async () => expect(await readWakes(database)).toHaveLength(1));
  const [reminder] = await readWakes(database);
  expect(reminder).toMatchObject({ kind: "reminder", outcome: "ran" });
  expect(
    await database.read((sql) => sql`SELECT id, reminded_at FROM requests ORDER BY id`),
  ).toEqual([
    { id: quiet, reminded_at: reminder!.at },
    { id: held, reminded_at: null },
  ]);
  await Bun.sleep(TIMINGS.remindSeen + 100);
  expect(toyBox.runs).toHaveLength(1);
});

test("a request nobody finished expires instead of earning a reminder", async () => {
  const { toyBox, database, now, startWaking } = await linkFakeChannel();
  const seenAt = now() - TIMINGS.remindSeen;
  await storeRequest(database, seenAt, { state: "seen", seen_at: seenAt, expires_at: now() });

  await startWaking();

  await waitFor(async () =>
    expect(await database.read((sql) => sql`SELECT state FROM requests`)).toEqual([
      { state: "expired" },
    ]),
  );
  await Bun.sleep(TIMINGS.debounceLimit);
  expect(toyBox.runs).toEqual([]);
});

test("a lead on another provider is never woken", async () => {
  const { toyBox, database, now, startWaking } = await linkFakeChannel({ provider: "claude" });
  const { scheduler } = await startWaking();

  await storeRequest(database, now());
  scheduler.reconsider();

  await Bun.sleep(TIMINGS.debounce + 150);
  expect(toyBox.runs).toEqual([]);
  expect(await readOutcomes(database)).toEqual([]);
  expect(await readBlock(database)).toBe("provider");
});

test("a deleted requests routine blocks wakes and 👀", async () => {
  const { toyBox, database, channelId, routine, now, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();

  toyBox.deleteRoutine(channelId, routine.id);
  await waitFor(async () => expect(await readBlock(database)).toBe("routine_missing"));
  await storeRequest(database, now());
  scheduler.reconsider();

  await Bun.sleep(TIMINGS.debounce + 150);
  expect(toyBox.runs).toEqual([]);
  expect(await readOutcomes(database)).toEqual([]);
});

test("a requests routine edited away from inbox still wakes the lead", async () => {
  const { toyBox, database, channelId, routine, now, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();

  toyBox.editRoutine(channelId, routine.id, { prompt: "Check on Slack." });
  await waitFor(async () =>
    expect(
      await database.read((sql) => sql`SELECT routine_state FROM links WHERE id = 'link'`),
    ).toEqual([{ routine_state: "drifted" }]),
  );
  await storeRequest(database, now());
  scheduler.reconsider();

  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  expect(await readBlock(database)).toBeNull();
});

test("a run Toy Box can't find marks the routine missing and blocks the link", async () => {
  const { toyBox, database, now, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();
  toyBox.failNextRun(404);

  await storeRequest(database, now());
  scheduler.reconsider();

  await waitFor(async () => expect(await readBlock(database)).toBe("routine_missing"));
  await Bun.sleep(TIMINGS.retry + 100);
  expect(toyBox.runs).toEqual([]);
  expect(await readOutcomes(database)).toEqual([{ kind: "requests", outcome: "missing" }]);
});

test("a run Toy Box refuses blocks the link instead of retrying", async () => {
  const { toyBox, database, now, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();
  // runChannelRoutineResponse answers a ChannelInputError with 422.
  toyBox.failNextRun(422);

  await storeRequest(database, now());
  scheduler.reconsider();

  await waitFor(async () => expect(await readBlock(database)).toBe("refused"));
  await Bun.sleep(TIMINGS.retry + 100);
  expect(toyBox.runs).toEqual([]);
  expect(await readOutcomes(database)).toEqual([{ kind: "requests", outcome: "refused" }]);
});

test("a run Toy Box fails is retried, and a Toy Box that went away is woken once it's back", async () => {
  const { toyBox, database, channelId, now, startWaking } = await linkFakeChannel();
  const { client, scheduler } = await startWaking();
  toyBox.failNextRun(500);

  await storeRequest(database, now());
  scheduler.reconsider();

  // Toy Box counts the run before the scheduler records it.
  await waitFor(async () =>
    expect(await readOutcomes(database)).toEqual([
      { kind: "requests", outcome: "failed" },
      { kind: "requests", outcome: "ran" },
    ]),
  );
  expect(toyBox.runs).toHaveLength(1);
  const [failed, ran] = await readWakes(database);
  expect(ran!.at - failed!.at).toBeGreaterThanOrEqual(TIMINGS.retry);

  toyBox.finishTurn(channelId);
  await toyBox.stop();
  await waitFor(() => expect(client.view(channelId).connected).toBe(false));
  await storeRequest(database, now());
  scheduler.reconsider();
  await Bun.sleep(TIMINGS.debounce + 150);
  expect(toyBox.runs).toHaveLength(1);

  toyBox.start();
  await waitFor(() => expect(toyBox.runs).toHaveLength(2));
});

test("a deleted Toy Box channel's link wakes nothing more", async () => {
  const { toyBox, database, channelId, now, startWaking } = await linkFakeChannel();
  const { client, scheduler } = await startWaking();
  toyBox.startTurn(channelId);
  await waitFor(() => expect(client.view(channelId).leadWorking).toBe(true));
  await storeRequest(database, now());
  scheduler.reconsider();

  toyBox.deleteChannel(channelId);

  await waitFor(async () => expect(await readBlock(database)).toBe("link_inactive"));
  await Bun.sleep(TIMINGS.steerAfter + 100);
  expect(await readOutcomes(database)).toEqual([]);
});

test("a decided proposal wakes its lead once, with or without a link", async () => {
  const { toyBox, database, channelId, routine, now, startWaking } = await linkFakeChannel();
  const newChannelId = toyBox.addChannel({ name: "New" });
  const newRoutine = toyBox.scheduleRoutine(newChannelId, REQUESTS_ROUTINE);
  const approval = {
    action: "set",
    patch: "[]",
    read_set: "{}",
    owner_user_id: "U-owner",
    card_channel_id: "C-link",
    state: "rejected",
    decided_by: "U-owner",
    decided_at: now(),
    created_by: "lead",
    created_at: now(),
    expires_at: now() + 60 * 60_000,
  };
  await database.write(
    (transaction) => transaction`
      INSERT INTO approvals ${transaction([
        { ...approval, id: "approval-1", number: 1, toybox_channel_id: channelId, link_id: "link" },
        {
          ...approval,
          id: "approval-2",
          number: 2,
          toybox_channel_id: newChannelId,
          link_id: null,
          action: "link",
          patch: JSON.stringify([{ field: "requests_routine_id", after: newRoutine.id }]),
        },
      ])}
    `,
  );

  await startWaking();

  await waitFor(() => expect(toyBox.runs).toHaveLength(2));
  expect(toyBox.runs.map(({ channelId, routineId }) => ({ channelId, routineId }))).toEqual(
    expect.arrayContaining([
      { channelId, routineId: routine.id },
      { channelId: newChannelId, routineId: newRoutine.id },
    ]),
  );
  toyBox.finishTurn(channelId);
  toyBox.finishTurn(newChannelId);
  await Bun.sleep(TIMINGS.steerAfter + 100);
  expect(toyBox.runs).toHaveLength(2);
  expect(
    (await readWakes(database)).map(({ kind, approval_id, outcome }) => ({
      kind,
      approval_id,
      outcome,
    })),
  ).toEqual(
    expect.arrayContaining([
      { kind: "setup", approval_id: "approval-1", outcome: "ran" },
      { kind: "setup", approval_id: "approval-2", outcome: "ran" },
    ]),
  );
});

test("a missed publication is caught up once, and never for a run before its series", async () => {
  // The standup's 9:00 run was missed, and the catch-up falls due 40 ms in.
  const scheduledAt = NOW;
  const { toyBox, database, channelId, startWaking } = await linkFakeChannel({
    start: scheduledAt + TIMINGS.catchUpAfter - 40,
  });
  const series = (name: string, schedule: string, registeredAt: number) => {
    const routine = toyBox.scheduleRoutine(channelId, {
      title: name,
      schedule,
      prompt: `Run \`toy-box-slack publish --series ${name}\` with today's changes.`,
    });
    return {
      link_id: "link",
      series: name,
      routine_id: routine.id,
      routine_state: "present",
      period: "day",
      schedule,
      registered_at: registeredAt,
    };
  };
  const standup = series("standup", "0 9 * * 1-5", scheduledAt - 24 * 60 * 60_000);
  const notes = series("notes", "0 9 * * 1-5", scheduledAt + 1);
  await database.write(
    (transaction) => transaction`INSERT INTO link_routines ${transaction([standup, notes])}`,
  );

  await startWaking();

  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  expect(toyBox.runs[0]).toMatchObject({ routineId: standup.routine_id, by: "api" });
  expect(toyBox.runs[0]!.at).toBeGreaterThanOrEqual(scheduledAt + TIMINGS.catchUpAfter);
  toyBox.finishTurn(channelId);
  await Bun.sleep(TIMINGS.steerAfter);
  expect(toyBox.runs).toHaveLength(1);
  expect(
    await database.read((sql) => sql`SELECT kind, publication_key, outcome FROM wakes`),
  ).toEqual([{ kind: "catch_up", publication_key: "standup/2026-10-27", outcome: "ran" }]);
});

test("a series whose schedule changed owes nothing for the run before the change", async () => {
  const scheduledAt = NOW;
  const { toyBox, database, channelId, startWaking } = await linkFakeChannel({
    start: scheduledAt + TIMINGS.catchUpAfter + 1_000,
  });
  const routine = toyBox.scheduleRoutine(channelId, {
    title: "Standup",
    schedule: "0 9 * * 1-5",
    prompt: "Run `toy-box-slack publish --series standup` with today's changes.",
  });
  await database.write(
    (transaction) => transaction`
      INSERT INTO link_routines ${transaction({
        link_id: "link",
        series: "standup",
        routine_id: routine.id,
        routine_state: "present",
        period: "day",
        schedule: "0 8 * * 1-5",
        registered_at: scheduledAt - 24 * 60 * 60_000,
      })}
    `,
  );

  // The snapshot shows the routine's new schedule, which registers the series again.
  await startWaking();

  await Bun.sleep(TIMINGS.catchUpAfter + 100);
  expect(toyBox.runs).toEqual([]);
  expect(
    await database.read((sql) => sql`SELECT schedule FROM link_routines WHERE series = 'standup'`),
  ).toEqual([{ schedule: "0 9 * * 1-5" }]);
});

test("an error storing a wake stops the scheduler and reports it", async () => {
  const { toyBox, database, channelId, now, errors, startWaking } = await linkFakeChannel();
  const { scheduler } = await startWaking();
  await database.write(
    (transaction) => transaction`
      CREATE TRIGGER fail_wake_writes BEFORE INSERT ON wakes
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
    `,
  );

  await storeRequest(database, now());
  scheduler.reconsider();

  await waitFor(() => expect(errors).toHaveLength(1));
  expect(errors[0]).toMatchObject({ message: expect.stringContaining("disk I/O error") });
  toyBox.finishTurn(channelId);
  await storeRequest(database, now());
  scheduler.reconsider();
  await Bun.sleep(TIMINGS.steerAfter + 100);
  expect(toyBox.runs).toHaveLength(1);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { Wake } from "@wakes/model/plan";
import { readWakeBlock, readWakePass, recordInbox, recordWake } from "./database";

const now = Date.parse("2026-10-27T16:00:00.000Z");
const seconds = (count: number) => now + count * 1_000;
const minutes = (count: number) => now + count * 60_000;

let stored = 0;

function storeRequest(database: BridgeDatabase, columns: Record<string, unknown> = {}) {
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
    created_at: minutes(-30),
    changed_at: minutes(-30),
    expires_at: minutes(7 * 24 * 60),
    ...columns,
  };
  return database.write(async (transaction) => {
    const [{ id }] = await transaction<{ id: number }[]>`
      INSERT INTO requests ${transaction(row)} RETURNING id
    `;
    return id;
  });
}

async function storeApproval(database: BridgeDatabase, columns: Record<string, unknown> = {}) {
  stored += 1;
  const row = {
    id: `approval-${stored}`,
    number: stored,
    toybox_channel_id: "toybox-link",
    link_id: "link",
    action: "set",
    patch: "[]",
    read_set: "{}",
    owner_user_id: "U-owner",
    card_channel_id: "C-link",
    state: "rejected",
    decided_by: "U-owner",
    decided_at: minutes(-10),
    created_by: "lead",
    created_at: minutes(-20),
    expires_at: minutes(40),
    ...columns,
  };
  await database.write((transaction) => transaction`INSERT INTO approvals ${transaction(row)}`);
  return row.id;
}

function storeWake(database: BridgeDatabase, columns: Record<string, unknown> = {}) {
  const row = {
    link_id: "link",
    approval_id: null,
    at: minutes(-1),
    kind: "requests",
    publication_key: null,
    outcome: "ran",
    ...columns,
  };
  return database.write((transaction) => transaction`INSERT INTO wakes ${transaction(row)}`);
}

function wake(changes: Partial<Wake> = {}): Wake {
  return {
    kind: "requests",
    channelId: "toybox-link",
    routineId: "routine-link",
    linkId: "link",
    approvalId: null,
    catchUp: null,
    reminded: [],
    ...changes,
  };
}

function readPass(database: BridgeDatabase, at = now) {
  return database.read((sql) => readWakePass(sql, at));
}

function readWakeState(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`
      SELECT last_wake_at, last_inbox_at, wakes_since_inbox, retry_at, blocked_reason
      FROM wake_state WHERE link_id = 'link'
    `,
  );
}

describe("reading a pass", () => {
  test("reads each link with its wake state, and a link never woken as fresh", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "link");
    await createStoredLink(database, "other");
    await database.write(
      (transaction) => transaction`
        INSERT INTO wake_state ${transaction({
          link_id: "other",
          last_wake_at: minutes(-9),
          last_inbox_at: minutes(-20),
          wakes_since_inbox: 2,
          retry_at: seconds(15),
          blocked_reason: "refused",
        })}
      `,
    );

    expect(await readPass(database)).toEqual({
      links: [
        {
          id: "link",
          channelId: "toybox-link",
          routineId: "routine-link",
          status: "active",
          routineState: "present",
          blockedReason: null,
          lastWakeAt: null,
          lastInboxAt: null,
          wakesSinceInbox: 0,
          retryAt: null,
          requests: [],
          setup: [],
          catchUps: [],
        },
        {
          id: "other",
          channelId: "toybox-other",
          routineId: "routine-other",
          status: "active",
          routineState: "present",
          blockedReason: "refused",
          lastWakeAt: minutes(-9),
          lastInboxAt: minutes(-20),
          wakesSinceInbox: 2,
          retryAt: seconds(15),
          requests: [],
          setup: [],
          catchUps: [],
        },
      ],
      proposals: [],
      ran: [],
    });
  });

  test("reads only the requests that may still need the lead", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const open = await storeRequest(database, { changed_at: minutes(-2) });
    const seen = await storeRequest(database, {
      state: "seen",
      seen_at: minutes(-40),
      attention: "updated",
      reminded_at: minutes(-35),
    });
    const working = await storeRequest(database, {
      state: "in_progress",
      seen_at: minutes(-50),
      touched_at: minutes(-45),
      held_at: minutes(-44),
      hold_reason: "waiting on a deploy",
    });
    await storeRequest(database, { state: "answering", seen_at: minutes(-9) });
    await storeRequest(database, { state: "answered", seen_at: minutes(-9) });
    await storeRequest(database, { state: "dismissed", seen_at: minutes(-9), closed_reason: "x" });
    await storeRequest(database, { state: "cancelled", closed_reason: "source_deleted" });
    await storeRequest(database, { state: "expired" });

    const [link] = (await readPass(database)).links;
    expect(link!.requests).toEqual([
      expect.objectContaining({
        id: open,
        state: "open",
        attention: null,
        heldAt: null,
        changedAt: minutes(-2),
        seenAt: null,
        touchedAt: null,
        remindedAt: null,
      }),
      expect.objectContaining({
        id: seen,
        state: "seen",
        attention: "updated",
        seenAt: minutes(-40),
        remindedAt: minutes(-35),
      }),
      expect.objectContaining({
        id: working,
        state: "in_progress",
        heldAt: minutes(-44),
        seenAt: minutes(-50),
        touchedAt: minutes(-45),
      }),
    ]);
  });

  test("counts the runs that landed in the budget's last hour", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const approval = await storeApproval(database, { reported_at: minutes(-1) });
    await storeWake(database, { at: minutes(-61) });
    await storeWake(database, { at: minutes(-59) });
    await storeWake(database, { at: minutes(-2), outcome: "failed" });
    await storeWake(database, {
      link_id: null,
      approval_id: approval,
      kind: "setup",
      at: minutes(-5),
    });

    expect((await readPass(database)).ran).toEqual([
      { linkId: "link", at: minutes(-59) },
      { linkId: null, at: minutes(-5) },
    ]);
  });

  describe("setup debts", () => {
    test("are the clicked proposals that are final and unreported, oldest first", async () => {
      const database = await openTestDatabase();
      await createStoredLink(database);
      const rejected = await storeApproval(database, { decided_at: minutes(-8) });
      const applied = await storeApproval(database, {
        state: "applied",
        decided_at: minutes(-12),
        applied_at: minutes(-9),
      });
      const stale = await storeApproval(database, {
        state: "stale",
        stale_reason: "the owner changed",
        decided_at: minutes(-7),
      });
      await storeApproval(database, { state: "approved" });
      await storeApproval(database, { state: "pending", decided_by: null, decided_at: null });
      await storeApproval(database, { state: "expired", decided_by: null, decided_at: null });
      await storeApproval(database, { reported_at: minutes(-1) });

      const [link] = (await readPass(database)).links;
      expect(link!.setup).toEqual([
        { approvalId: applied, decidedAt: minutes(-9) },
        { approvalId: rejected, decidedAt: minutes(-8) },
        { approvalId: stale, decidedAt: minutes(-7) },
      ]);
    });

    test("are settled by a run that landed, not one that failed", async () => {
      const database = await openTestDatabase();
      await createStoredLink(database);
      const told = await storeApproval(database);
      const untold = await storeApproval(database);
      await storeWake(database, { kind: "setup", approval_id: told, outcome: "ran" });
      await storeWake(database, { kind: "setup", approval_id: untold, outcome: "failed" });

      const [link] = (await readPass(database)).links;
      expect(link!.setup.map(({ approvalId }) => approvalId)).toEqual([untold]);
    });

    test("for a channel without a link run the routine the proposal named", async () => {
      const database = await openTestDatabase();
      const proposed = (routineId: string) =>
        JSON.stringify([
          { field: "slack_channel_id", after: "C-new" },
          { field: "requests_routine_id", after: routineId },
        ]);
      const columns = { toybox_channel_id: "toybox-new", link_id: null, action: "link" };
      const failing = await storeApproval(database, {
        ...columns,
        patch: proposed("routine-new"),
        decided_at: minutes(-6),
      });
      const fresh = await storeApproval(database, {
        ...columns,
        toybox_channel_id: "toybox-fresh",
        patch: proposed("routine-fresh"),
        decided_at: minutes(-3),
      });
      const missing = await storeApproval(database, { ...columns, patch: proposed("gone") });
      const refused = await storeApproval(database, { ...columns, patch: proposed("refused") });
      await storeApproval(database, { ...columns, action: "allow" });
      for (const at of [minutes(-5), minutes(-4)]) {
        await storeWake(database, {
          link_id: null,
          approval_id: failing,
          kind: "setup",
          at,
          outcome: "failed",
        });
      }
      for (const [approval_id, outcome] of [
        [missing, "missing"],
        [refused, "refused"],
      ]) {
        await storeWake(database, { link_id: null, approval_id, kind: "setup", outcome });
      }

      expect((await readPass(database)).proposals).toEqual([
        {
          approvalId: failing,
          channelId: "toybox-new",
          routineId: "routine-new",
          failures: { count: 2, lastAt: minutes(-4) },
        },
        {
          approvalId: fresh,
          channelId: "toybox-fresh",
          routineId: "routine-fresh",
          failures: { count: 0, lastAt: null },
        },
      ]);
    });

    test("belong to the link that now holds the proposal's channel", async () => {
      const database = await openTestDatabase();
      const approval = await storeApproval(database, {
        link_id: null,
        action: "link",
        state: "applied",
        applied_at: minutes(-9),
        patch: JSON.stringify([{ field: "requests_routine_id", after: "routine-link" }]),
      });
      await createStoredLink(database);

      const pass = await readPass(database);
      expect(pass.links[0]!.setup).toEqual([{ approvalId: approval, decidedAt: minutes(-9) }]);
      expect(pass.proposals).toEqual([]);
    });
  });

  describe("catch-ups", () => {
    // Schedules run in local time, so these tests pin a zone.
    const zone = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "America/Los_Angeles";
    });
    afterAll(() => {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    });

    const local = (value: string) => new Date(value).getTime();

    function storeSeries(database: BridgeDatabase, series: string, registeredAt: number) {
      const row = {
        link_id: "link",
        series,
        routine_id: `routine-${series}`,
        routine_state: "present",
        period: "day",
        schedule: "0 16 * * 1-5",
        registered_at: registeredAt,
      };
      return database.write(
        (transaction) => transaction`INSERT INTO link_routines ${transaction(row)}`,
      );
    }

    function storePublication(database: BridgeDatabase, key: string, state: string) {
      stored += 1;
      const row = {
        id: `outbox-${stored}`,
        number: stored,
        link_id: "link",
        kind: "publication",
        channel_id: "C-link",
        publication_key: key,
        payload: "{}",
        payload_hash: "hash",
        state,
        created_at: 0,
        updated_at: 0,
      };
      return database.write((transaction) => transaction`INSERT INTO outbox ${transaction(row)}`);
    }

    test("are owed for the latest scheduled run since the series was registered", async () => {
      const database = await openTestDatabase();
      await createStoredLink(database);
      await storeSeries(database, "standup", local("2026-10-20T09:00:00"));
      await storeSeries(database, "notes", local("2026-10-27T16:00:01"));

      const [link] = (await readPass(database, local("2026-10-28T09:00:00"))).links;
      expect(link!.catchUps).toEqual([
        {
          series: "standup",
          routineId: "routine-standup",
          routineState: "present",
          scheduledAt: local("2026-10-27T16:00:00"),
          key: "standup/2026-10-27",
        },
      ]);
    });

    test("are settled by an item that holds the key, or a catch-up that didn't fail", async () => {
      const database = await openTestDatabase();
      await createStoredLink(database);
      for (const series of ["published", "skipped", "failed", "caught", "retrying"]) {
        await storeSeries(database, series, local("2026-10-20T09:00:00"));
      }
      await storePublication(database, "published/2026-10-27", "sent");
      await storePublication(database, "skipped/2026-10-27", "skipped");
      await storePublication(database, "failed/2026-10-27", "failed");
      await storePublication(database, "published/2026-10-26", "failed");
      await storeWake(database, {
        kind: "catch_up",
        publication_key: "caught/2026-10-27",
        outcome: "missing",
      });
      await storeWake(database, {
        kind: "catch_up",
        publication_key: "retrying/2026-10-27",
        outcome: "failed",
      });

      const [link] = (await readPass(database, local("2026-10-28T09:00:00"))).links;
      expect(link!.catchUps.map(({ key }) => key)).toEqual([
        "failed/2026-10-27",
        "retrying/2026-10-27",
      ]);
    });
  });
});

describe("recording a wake", () => {
  test("a run that landed counts toward the backoff and delivers its reminders", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const reminded = await storeRequest(database, { state: "seen", seen_at: minutes(-40) });
    const other = await storeRequest(database, { state: "seen", seen_at: minutes(-40) });

    await database.write((transaction) =>
      recordWake(transaction, wake({ kind: "reminder", reminded: [reminded] }), "ran", now),
    );
    await database.write((transaction) => recordWake(transaction, wake(), "ran", seconds(30)));

    expect(await readWakeState(database)).toEqual([
      {
        last_wake_at: seconds(30),
        last_inbox_at: null,
        wakes_since_inbox: 2,
        retry_at: null,
        blocked_reason: null,
      },
    ]);
    expect(
      await database.read((sql) => sql`SELECT id, reminded_at FROM requests ORDER BY id`),
    ).toEqual([
      { id: reminded, reminded_at: now },
      { id: other, reminded_at: null },
    ]);
    expect(
      await database.read((sql) => sql`SELECT link_id, at, kind, outcome FROM wakes ORDER BY id`),
    ).toEqual([
      { link_id: "link", at: now, kind: "reminder", outcome: "ran" },
      { link_id: "link", at: seconds(30), kind: "requests", outcome: "ran" },
    ]);
  });

  test("a failed run retries on a delay that doubles until a run doesn't fail", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const record = (outcome: "ran" | "failed", at: number, changes: Partial<Wake> = {}) =>
      database.write((transaction) => recordWake(transaction, wake(changes), outcome, at));
    const retryAt = async () => (await readWakeState(database))[0].retry_at;

    await record("failed", now);
    expect(await retryAt()).toBe(seconds(15));
    await record("failed", seconds(15), { kind: "catch_up", catchUp: { series: "s", key: "s/1" } });
    expect(await retryAt()).toBe(seconds(45));
    await record("ran", seconds(45));
    expect(await retryAt()).toBeNull();
    await record("failed", seconds(60));
    expect(await retryAt()).toBe(seconds(75));
  });

  test("a refusal blocks the link, unless a catch-up was refused", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const catchUp = { kind: "catch_up", catchUp: { series: "standup", key: "standup/1" } } as const;

    await database.write((transaction) => recordWake(transaction, wake(catchUp), "refused", now));
    expect(await readWakeState(database)).toEqual([]);
    await database.write((transaction) => recordWake(transaction, wake(), "refused", now));
    expect(await readWakeState(database)).toEqual([
      expect.objectContaining({ blocked_reason: "refused" }),
    ]);
  });

  test("a missing routine marks the requests routine missing, unless it changed", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const readLink = () =>
      database.read((sql) => sql`SELECT requests_routine_id, routine_state, updated_at FROM links`);

    const replaced = wake({ routineId: "routine-before" });
    await database.write((transaction) => recordWake(transaction, replaced, "missing", now));
    expect(await readLink()).toEqual([
      { requests_routine_id: "routine-link", routine_state: "present", updated_at: 0 },
    ]);
    await database.write((transaction) => recordWake(transaction, wake(), "missing", now));
    expect(await readLink()).toEqual([
      { requests_routine_id: "routine-link", routine_state: "missing", updated_at: now },
    ]);
  });

  test("a catch-up's missing routine marks only its series' routine missing", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await database.write(
      (transaction) => transaction`
        INSERT INTO link_routines (link_id, series, routine_id, routine_state, period, schedule,
          registered_at)
        VALUES ('link', 'standup', 'routine-standup', 'present', 'day', '0 16 * * 1-5', 0),
          ('link', 'notes', 'routine-notes', 'present', 'week', '0 16 * * 5', 0)
      `,
    );

    const catchUp = wake({
      kind: "catch_up",
      routineId: "routine-standup",
      catchUp: { series: "standup", key: "standup/2026-10-27" },
    });
    await database.write((transaction) => recordWake(transaction, catchUp, "missing", now));

    expect(
      await database.read(
        (sql) => sql`SELECT series, routine_state FROM link_routines ORDER BY series`,
      ),
    ).toEqual([
      { series: "notes", routine_state: "present" },
      { series: "standup", routine_state: "missing" },
    ]);
    expect(
      await database.read((sql) => sql`SELECT routine_state FROM links WHERE id = 'link'`),
    ).toEqual([{ routine_state: "present" }]);
    expect(await readWakeState(database)).toEqual([]);
  });

  test("a catch-up that landed leaves the link's backoff alone", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    const catchUp = wake({ kind: "catch_up", catchUp: { series: "standup", key: "standup/1" } });

    await database.write((transaction) => recordWake(transaction, catchUp, "ran", now));

    expect(await readWakeState(database)).toEqual([]);
    expect(
      await database.read((sql) => sql`SELECT kind, publication_key, outcome FROM wakes`),
    ).toEqual([{ kind: "catch_up", publication_key: "standup/1", outcome: "ran" }]);
  });

  test("a run for no link, or for a link removed meanwhile, keeps only the log", async () => {
    const database = await openTestDatabase();
    const approval = await storeApproval(database, { link_id: null });
    const proposal = wake({ kind: "setup", linkId: null, approvalId: approval });

    await database.write((transaction) => recordWake(transaction, proposal, "failed", now));
    await database.write((transaction) => recordWake(transaction, wake(), "ran", now));
    await database.write((transaction) => recordWake(transaction, wake(), "refused", now));

    expect(await database.read((sql) => sql`SELECT link_id, kind, outcome FROM wakes`)).toEqual([
      { link_id: null, kind: "setup", outcome: "failed" },
      { link_id: "link", kind: "requests", outcome: "ran" },
      { link_id: "link", kind: "requests", outcome: "refused" },
    ]);
    expect(await database.read((sql) => sql`SELECT * FROM wake_state`)).toEqual([]);
  });
});

describe("recording an inbox read", () => {
  test("ends the backoff and any stall, and keeps the rest of the wake state", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    for (const at of [minutes(-9), minutes(-6), minutes(-3), minutes(-1)]) {
      await database.write((transaction) => recordWake(transaction, wake(), "ran", at));
    }
    await database.write((transaction) => recordWake(transaction, wake(), "failed", now));

    await database.write((transaction) => recordInbox(transaction, "link", seconds(5)));

    expect(await readWakeState(database)).toEqual([
      {
        last_wake_at: minutes(-1),
        last_inbox_at: seconds(5),
        wakes_since_inbox: 0,
        retry_at: seconds(15),
        blocked_reason: null,
      },
    ]);
  });

  test("of a link never woken starts its wake state", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    await database.write((transaction) => recordInbox(transaction, "link", now));

    expect(await readWakeState(database)).toEqual([
      {
        last_wake_at: null,
        last_inbox_at: now,
        wakes_since_inbox: 0,
        retry_at: null,
        blocked_reason: null,
      },
    ]);
  });
});

describe("reading a link's wake block", () => {
  function readBlock(database: BridgeDatabase, linkId = "link") {
    return database.read((sql) => readWakeBlock(sql, linkId));
  }

  test("is nothing for an active link with its routine, before Toy Box names the provider", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    expect(await readBlock(database)).toBeNull();
  });

  test("names what a person must fix, the link before the routine before the lead", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await database.write(async (transaction) => {
      await transaction`UPDATE links SET routine_state = 'drifted'`;
      await transaction`
        INSERT INTO toybox_streams (toybox_channel_id, provider) VALUES ('toybox-link', 'copilot')
      `;
    });
    expect(await readBlock(database)).toBeNull();

    await database.write((transaction) => recordWake(transaction, wake(), "refused", now));
    expect(await readBlock(database)).toBe("refused");
    await database.write(
      (transaction) => transaction`UPDATE toybox_streams SET provider = 'openai'`,
    );
    expect(await readBlock(database)).toBe("provider");
    await database.write((transaction) => transaction`UPDATE links SET routine_state = 'missing'`);
    expect(await readBlock(database)).toBe("routine_missing");
    await database.write(
      (transaction) => transaction`
        UPDATE links SET status = 'suspended', status_reason = 'toybox_channel_deleted'
      `,
    );
    expect(await readBlock(database)).toBe("link_inactive");
  });

  test("calls a link that's gone inactive", async () => {
    const database = await openTestDatabase();

    expect(await readBlock(database)).toBe("link_inactive");
  });
});

import { expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { bridgeMigrations, openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";

const ACTIVE_STATES = ["open", "seen", "in_progress", "answering"];
const CLOSED_STATES = ["answered", "dismissed", "cancelled", "expired"];
const CLOSED_REASONS: Record<string, string> = {
  dismissed: "Answered in the standup",
  cancelled: "source_deleted",
};

/**
 * Store the owner's mention request, open unless `request` says otherwise, with what its
 * state requires, and return its ID.
 */
async function insertRequest(database: BridgeDatabase, request: Record<string, unknown> = {}) {
  const state = typeof request.state === "string" ? request.state : "open";
  const row = {
    link_id: "link",
    channel_id: "C-link",
    root_ts: "1700000100.000100",
    source_ts: "1700000100.000100",
    requester_user_id: "U-owner",
    reason: "mention",
    state,
    input_hash: "hash",
    created_at: 0,
    changed_at: 0,
    seen_at: state === "open" ? null : 1,
    expires_at: 604_800_000,
    closed_reason: CLOSED_REASONS[state] ?? null,
    ...request,
  };
  const [{ id }] = await database.write(
    (transaction) => transaction`INSERT INTO requests ${transaction(row)} RETURNING id`,
  );
  return id as number;
}

test("only an open request, or one closed before anyone read it, has never been seen", async () => {
  const database = await openTestDatabase();
  const seen =
    "CHECK constraint failed: state IN ('cancelled', 'expired') OR (seen_at IS NULL) = (state = 'open')";

  await insertRequest(database, { state: "cancelled", seen_at: null });
  await insertRequest(database, { state: "expired", seen_at: null });
  await expect(insertRequest(database, { seen_at: 1 })).rejects.toThrow(seen);
  for (const state of ["seen", "in_progress", "answering", "answered", "dismissed"]) {
    await expect(insertRequest(database, { state, seen_at: null })).rejects.toThrow(seen);
  }
});

test("a hold has a reason and pauses only a seen or in-progress request", async () => {
  const database = await openTestDatabase();
  const hold = { held_at: 1, hold_reason: "Waiting on the deploy" };
  const pairing = "CHECK constraint failed: (held_at IS NULL) = (hold_reason IS NULL)";

  await insertRequest(database, { state: "seen", ...hold });
  await insertRequest(database, { state: "in_progress", root_ts: "1700000200.000100", ...hold });
  await expect(insertRequest(database, { state: "answered", held_at: 1 })).rejects.toThrow(pairing);
  await expect(
    insertRequest(database, { state: "answered", hold_reason: "Later" }),
  ).rejects.toThrow(pairing);
  for (const state of ["open", "answering", ...CLOSED_STATES]) {
    await expect(insertRequest(database, { state, ...hold })).rejects.toThrow(
      "CHECK constraint failed: held_at IS NULL OR state IN ('seen', 'in_progress')",
    );
  }
});

test("only a request the lead has seen and that's still active needs its attention", async () => {
  const database = await openTestDatabase();
  const read = ["seen", "in_progress", "answering"];

  for (const state of ["open", ...CLOSED_STATES]) {
    await expect(insertRequest(database, { state, attention: "reply_failed" })).rejects.toThrow(
      "CHECK constraint failed: attention IS NULL OR state IN ('seen', 'in_progress', 'answering')",
    );
  }
  await expect(
    insertRequest(database, { state: "seen", attention: "source_unverified" }),
  ).rejects.toThrow(
    "CHECK constraint failed: attention IS NULL OR attention IN ('updated', 'reply_failed')",
  );
  for (const [index, state] of read.entries()) {
    await insertRequest(database, {
      state,
      root_ts: `1700000100.00010${index}`,
      attention: "updated",
    });
  }
});

test("only an active request waits on repair to verify its source", async () => {
  const database = await openTestDatabase();

  for (const state of CLOSED_STATES) {
    await expect(insertRequest(database, { state, source_unverified_at: 1 })).rejects.toThrow(
      "CHECK constraint failed: source_unverified_at IS NULL OR state IN ('open', 'seen', 'in_progress', 'answering')",
    );
  }
  for (const [index, state] of ACTIVE_STATES.entries()) {
    await insertRequest(database, {
      state,
      root_ts: `1700000100.00010${index}`,
      source_unverified_at: 1,
    });
  }
});

test("a request says why it closed exactly when it was dismissed or cancelled", async () => {
  const database = await openTestDatabase();
  const closing =
    "CHECK constraint failed: (closed_reason IS NOT NULL) = (state IN ('dismissed', 'cancelled'))";

  for (const state of CLOSED_STATES) await insertRequest(database, { state });
  for (const state of ["dismissed", "cancelled"]) {
    await expect(insertRequest(database, { state, closed_reason: null })).rejects.toThrow(closing);
  }
  for (const state of ["answered", "expired", "open"]) {
    await expect(insertRequest(database, { state, closed_reason: "link_removed" })).rejects.toThrow(
      closing,
    );
  }
});

test("inbox reports only a request the lead read that was then cancelled or expired", async () => {
  const database = await openTestDatabase();
  const reporting =
    "CHECK constraint failed: closed_reported_at IS NULL OR (state IN ('cancelled', 'expired') AND seen_at IS NOT NULL)";

  for (const state of [...ACTIVE_STATES, "answered", "dismissed"]) {
    await expect(insertRequest(database, { state, closed_reported_at: 1 })).rejects.toThrow(
      reporting,
    );
  }
  for (const state of ["cancelled", "expired"]) {
    await expect(
      insertRequest(database, { state, seen_at: null, closed_reported_at: 1 }),
    ).rejects.toThrow(reporting);
    await insertRequest(database, { state, closed_reported_at: 1 });
  }
});

test("never hands out a request's number again, even once its row is gone", async () => {
  const database = await openTestDatabase();
  await insertRequest(database, { state: "answered" });
  const newest = await insertRequest(database);

  await database.write((transaction) => transaction`DELETE FROM requests WHERE id = ${newest}`);
  expect(await insertRequest(database)).toBe(newest + 1);
  await database.write((transaction) => transaction`DELETE FROM requests`);
  expect(await insertRequest(database)).toBe(newest + 2);
});

test("a version 3 file keeps every request and its messages as they were, and gives the next a number no request has had", async () => {
  const path = join(createTestFolder(), "bridge.db");
  const old = await openBridgeDatabase(path, bridgeMigrations.slice(0, 3));
  const answered = await insertRequest(old, {
    id: 3,
    state: "answered",
    touched_at: 5,
    reminded_at: 6,
    late: 1,
    progress_ts: "1700000150.000100",
  });
  const cancelled = await insertRequest(old, {
    id: 5,
    state: "cancelled",
    root_ts: "1700000300.000100",
  });
  const active = await insertRequest(old, {
    id: 9,
    state: "in_progress",
    root_ts: "1700000200.000100",
    input_rev: 3,
    served_rev: 2,
    attention: "updated",
    source_unverified_at: 7,
    held_at: 8,
    hold_reason: "Asked Alice",
  });
  await old.write(
    (transaction) => transaction`
      INSERT INTO request_messages (request_id, channel_id, ts) VALUES
        (${answered}, 'C-link', '1700000100.000100'),
        (${cancelled}, 'C-link', '1700000300.000100'),
        (${active}, 'C-link', '1700000200.000100'),
        (${active}, 'C-link', '1700000210.000100')
    `,
  );
  const requests = await old.read((sql) => sql`SELECT * FROM requests ORDER BY id`);
  const messages = await old.read(
    (sql) => sql`SELECT * FROM request_messages ORDER BY request_id, ts`,
  );
  await old.close();

  const database = await openBridgeDatabase(path);
  onTestFinished(() => database.close());

  expect(await database.read((sql) => sql`SELECT * FROM requests ORDER BY id`)).toEqual(
    requests.map((request: Record<string, unknown>) => ({ ...request, closed_reported_at: null })),
  );
  expect(
    await database.read((sql) => sql`SELECT * FROM request_messages ORDER BY request_id, ts`),
  ).toEqual(messages);
  // Deleting a request still takes its messages with it, and its number isn't handed out again.
  await database.write((transaction) => transaction`DELETE FROM requests WHERE id = ${active}`);
  expect(
    await database.read((sql) => sql`SELECT request_id FROM request_messages ORDER BY request_id`),
  ).toEqual([{ request_id: answered }, { request_id: cancelled }]);
  expect(await insertRequest(database)).toBe(active + 1);
});

test("a requester has at most one active request in a thread", async () => {
  const database = await openTestDatabase();

  for (const state of ACTIVE_STATES) {
    await insertRequest(database, { state });
    await expect(insertRequest(database)).rejects.toThrow(
      "UNIQUE constraint failed: requests.link_id, requests.requester_user_id, requests.root_ts",
    );
    await database.write((transaction) => transaction`DELETE FROM requests`);
  }
  for (const state of CLOSED_STATES) await insertRequest(database, { state });
  await insertRequest(database);
  await insertRequest(database, { requester_user_id: "U-allowed" });
  await insertRequest(database, { root_ts: "1700000200.000100" });
  await insertRequest(database, { link_id: "other" });
});

test("a message belongs to at most one request", async () => {
  const database = await openTestDatabase();
  const answered = await insertRequest(database, { state: "answered" });
  const open = await insertRequest(database);
  const join = (requestId: number) =>
    database.write(
      (transaction) =>
        transaction`INSERT INTO request_messages ${transaction({
          request_id: requestId,
          channel_id: "C-link",
          ts: "1700000100.000100",
        })}`,
    );

  await join(answered);
  await expect(join(open)).rejects.toThrow(
    "UNIQUE constraint failed: request_messages.channel_id, request_messages.ts",
  );
});

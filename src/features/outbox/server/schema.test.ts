import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { bridgeMigrations, openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";

const LIVE_STATES = [
  "queued",
  "sending",
  "sent",
  "delivery_unknown",
  "stray",
  "retracted",
  "skipped",
];
const DEAD_STATES = ["failed", "dropped", "superseded", "cancelled"];
let nextNumber = 1;

/** Store an outbox item: a queued final reply to r14's first revision unless `item` says otherwise. */
function insertItem(database: BridgeDatabase, item: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    number: nextNumber++,
    link_id: "link",
    request_id: 14,
    request_rev: 1,
    kind: "reply",
    phase: "final",
    channel_id: "C0123",
    payload: "{}",
    payload_hash: "hash",
    state: "queued",
    created_at: 0,
    updated_at: 0,
    ...item,
  };
  return database.write((transaction) => transaction`INSERT INTO outbox ${transaction(row)}`);
}

function insertPublication(database: BridgeDatabase, item: Record<string, unknown>) {
  return insertItem(database, {
    kind: "publication",
    phase: null,
    request_id: null,
    request_rev: null,
    publication_key: "release-notes/2026-W43",
    ...item,
  });
}

describe("final replies", () => {
  test("allow one live final reply per request revision, whatever its delivery state", async () => {
    const database = await openTestDatabase();

    for (const [requestId, state] of LIVE_STATES.entries()) {
      await insertItem(database, { request_id: requestId, state });
      await expect(insertItem(database, { request_id: requestId })).rejects.toThrow(
        "UNIQUE constraint failed: outbox.request_id, outbox.request_rev",
      );
    }
  });

  test("allow another final reply once the earlier one is failed, dropped, superseded or cancelled", async () => {
    const database = await openTestDatabase();

    for (const [requestId, state] of DEAD_STATES.entries()) {
      await insertItem(database, { request_id: requestId, state });
      await insertItem(database, { request_id: requestId });
    }
  });

  test("allow a final reply to each new revision and any number of follow-ups", async () => {
    const database = await openTestDatabase();
    await insertItem(database, { state: "sent" });

    await insertItem(database, { request_rev: 2 });
    await insertItem(database, { phase: "follow_up" });
    await insertItem(database, { phase: "follow_up" });
  });

  test("can't slip past their unique index without a request or revision", async () => {
    const database = await openTestDatabase();

    await expect(insertItem(database, { request_rev: null })).rejects.toThrow(
      "CHECK constraint failed",
    );
    await expect(insertItem(database, { request_id: null })).rejects.toThrow(
      "CHECK constraint failed",
    );
  });
});

describe("publications", () => {
  test("allow one live publication per key in each link", async () => {
    const database = await openTestDatabase();

    for (const [index, state] of LIVE_STATES.entries()) {
      const key = `digest/${index}`;
      await insertPublication(database, { publication_key: key, state });
      await expect(insertPublication(database, { publication_key: key })).rejects.toThrow(
        "UNIQUE constraint failed: outbox.link_id, outbox.publication_key",
      );
    }
  });

  test("keep a correction and another link's publication apart from the original", async () => {
    const database = await openTestDatabase();
    await insertPublication(database, { state: "sent" });

    await insertPublication(database, { publication_key: "release-notes/2026-W43/correction" });
    await insertPublication(database, { link_id: "other-link" });
  });

  test("free their key once the item is failed, dropped, superseded or cancelled", async () => {
    const database = await openTestDatabase();

    for (const [index, state] of DEAD_STATES.entries()) {
      const key = `digest/${index}`;
      await insertPublication(database, { publication_key: key, state });
      await insertPublication(database, { publication_key: key });
    }
  });

  test("can't slip past their unique index without a link or key", async () => {
    const database = await openTestDatabase();

    await expect(insertPublication(database, { link_id: null })).rejects.toThrow(
      "CHECK constraint failed",
    );
    await expect(insertPublication(database, { publication_key: null })).rejects.toThrow(
      "CHECK constraint failed",
    );
  });
});

test("pairs each phase with the kind of item it belongs to", async () => {
  const database = await openTestDatabase();
  const valid = [
    { kind: "reply", phase: "final" },
    { kind: "reply", phase: "follow_up" },
    { kind: "card", phase: "post" },
    { kind: "card", phase: "update" },
    { kind: "progress", phase: null },
    { kind: "reaction", phase: null },
  ];
  const invalid = [
    { kind: "reply", phase: null },
    { kind: "reply", phase: "post" },
    { kind: "card", phase: null },
    { kind: "card", phase: "final" },
    { kind: "status", phase: "final" },
  ];

  for (const [index, item] of valid.entries())
    await insertItem(database, { ...item, request_id: index });
  for (const item of invalid) {
    await expect(insertItem(database, item)).rejects.toThrow("CHECK constraint failed");
  }
});

describe("version 2 upgrades", () => {
  test("keep every item as it was, and number the next after every item there has been", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const old = await openBridgeDatabase(path, bridgeMigrations.slice(0, 2));
    await old.write(async (transaction) => {
      for (const number of [1, 2]) {
        await transaction`INSERT INTO outbox ${transaction({
          id: `item-${number}`,
          number,
          link_id: "link",
          request_id: 14 + number,
          approval_id: "approval",
          request_rev: 2,
          kind: "reply",
          phase: "final",
          channel_id: "C0123",
          thread_ts: "1700000100.000100",
          publication_key: `release-notes/${number}`,
          replaces: "item-0",
          payload: '{"text":"Done"}',
          payload_hash: "hash",
          metadata_ok: 1,
          state: "sent",
          attempts: 2,
          next_attempt_at: 3,
          slack_ts: "1700000200.000100",
          error: "ratelimited",
          evidence: "response",
          created_at: 4,
          updated_at: 5,
          attempt_method: "chat.postMessage",
          attempt_started_at: 6,
          reconcile_pass: 1,
        })}`;
      }
    });
    const items = await old.read((sql) => sql`SELECT * FROM outbox ORDER BY number`);
    await old.close();

    const database = await openBridgeDatabase(path);
    onTestFinished(() => database.close());

    expect(await database.read((sql) => sql`SELECT * FROM outbox ORDER BY number`)).toEqual(items);
    await database.write((transaction) => transaction`DELETE FROM outbox WHERE number = 2`);
    await insertItem(database, { number: undefined, request_id: 20 });
    expect(
      await database.read((sql) => sql`SELECT number FROM outbox WHERE request_id = 20`),
    ).toEqual([{ number: 3 }]);
  });
});

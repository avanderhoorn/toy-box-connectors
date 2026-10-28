import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";

function insertStream(database: BridgeDatabase, stream: Record<string, unknown>) {
  const row = { toybox_channel_id: crypto.randomUUID(), ...stream };
  return database.write(
    (transaction) => transaction`INSERT INTO toybox_streams ${transaction(row)}`,
  );
}

test("a stream knows the lead as working, waiting or idle, or not yet", async () => {
  const database = await openTestDatabase();

  await insertStream(database, {});
  await insertStream(database, { lead_state: "working" });
  await insertStream(database, { lead_state: "waiting", waiting_for: "The owner's call" });
  await insertStream(database, { lead_state: "idle" });
  await expect(insertStream(database, { lead_state: "busy" })).rejects.toThrow(
    "CHECK constraint failed: lead_state IS NULL OR lead_state IN ('working', 'waiting', 'idle')",
  );
});

test("a stream says what the lead waits for exactly while it's waiting", async () => {
  const database = await openTestDatabase();
  const tie = "CHECK constraint failed: (waiting_for IS NOT NULL) = (lead_state IS 'waiting')";

  await expect(insertStream(database, { lead_state: "waiting" })).rejects.toThrow(tie);
  for (const lead_state of ["working", "idle", null]) {
    await expect(insertStream(database, { lead_state, waiting_for: "The owner" })).rejects.toThrow(
      tie,
    );
  }
});

test("a stream keeps what the lead waited for before this turn only while it works", async () => {
  const database = await openTestDatabase();
  const tie = "CHECK constraint failed: restore_for IS NULL OR lead_state IS 'working'";

  await insertStream(database, { lead_state: "working", restore_for: "The owner" });
  for (const lead_state of ["idle", null]) {
    await expect(insertStream(database, { lead_state, restore_for: "The owner" })).rejects.toThrow(
      tie,
    );
  }
  await expect(
    insertStream(database, { lead_state: "waiting", waiting_for: "x", restore_for: "y" }),
  ).rejects.toThrow(tie);
});

test("a stream keeps each wake time only alongside what it belongs to", async () => {
  const database = await openTestDatabase();

  await insertStream(database, {
    lead_state: "waiting",
    waiting_for: "The owner",
    waiting_wake_at: 60_000,
  });
  await insertStream(database, {
    lead_state: "working",
    restore_for: "The owner",
    restore_wake_at: 60_000,
  });
  await expect(
    insertStream(database, { lead_state: "idle", waiting_wake_at: 60_000 }),
  ).rejects.toThrow("CHECK constraint failed: waiting_wake_at IS NULL OR waiting_for IS NOT NULL");
  await expect(
    insertStream(database, { lead_state: "working", restore_wake_at: 60_000 }),
  ).rejects.toThrow("CHECK constraint failed: restore_wake_at IS NULL OR restore_for IS NOT NULL");
});

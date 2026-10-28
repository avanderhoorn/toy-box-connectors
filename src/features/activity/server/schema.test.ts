import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";

/** Store an open channel-wide coverage gap unless `gap` says otherwise. */
function insertGap(database: BridgeDatabase, gap: Record<string, unknown>) {
  const row = {
    link_id: "link",
    channel_id: "C-link",
    scope: "channel",
    oldest_ts: "1700000000.000100",
    latest_ts: "1700000600.000200",
    state: "open",
    reason: "reconnect",
    opened_at: 0,
    ...gap,
  };
  return database.write((transaction) => transaction`INSERT INTO coverage ${transaction(row)}`);
}

test("a cursor never marks read past what activity served", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await database.write(
    (transaction) =>
      transaction`INSERT INTO cursors (link_id, served_through_seq) VALUES ('link', 5)`,
  );

  await database.write((transaction) => transaction`UPDATE cursors SET through_seq = 5`);
  await expect(
    database.write((transaction) => transaction`UPDATE cursors SET through_seq = 6`),
  ).rejects.toThrow("CHECK constraint failed: through_seq <= served_through_seq");
});

test("a coverage gap names a thread exactly when it covers one", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const pairing = "CHECK constraint failed: (thread_ts IS NOT NULL) = (scope = 'thread')";

  await insertGap(database, { scope: "channel" });
  await insertGap(database, { scope: "thread", thread_ts: "1700000000.000100" });
  await expect(insertGap(database, { scope: "thread" })).rejects.toThrow(pairing);
  await expect(
    insertGap(database, { scope: "channel", thread_ts: "1700000000.000100" }),
  ).rejects.toThrow(pairing);
});

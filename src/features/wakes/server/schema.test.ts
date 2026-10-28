import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";

function insertWake(database: BridgeDatabase, wake: Record<string, unknown>) {
  const row = { link_id: "link", at: 0, kind: "requests", outcome: "ran", ...wake };
  return database.write((transaction) => transaction`INSERT INTO wakes ${transaction(row)}`);
}

test("a wake names the period it ran for exactly when it's a catch-up", async () => {
  const database = await openTestDatabase();
  const tie = "CHECK constraint failed: (publication_key IS NOT NULL) = (kind = 'catch_up')";

  await insertWake(database, { kind: "catch_up", publication_key: "release-notes/2026-10-26" });
  await expect(insertWake(database, { kind: "catch_up" })).rejects.toThrow(tie);
  await expect(
    insertWake(database, { kind: "reminder", publication_key: "release-notes/2026-10-26" }),
  ).rejects.toThrow(tie);
});

test("a link's wake state stores only the block a refused run leaves", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const insert = (blocked_reason: string | null) =>
    database.write(async (transaction) => {
      await transaction`DELETE FROM wake_state`;
      await transaction`INSERT INTO wake_state ${transaction({ link_id: "link", blocked_reason })}`;
    });

  await insert(null);
  await insert("refused");
  for (const reason of ["routine_missing", "provider", "link_inactive"]) {
    await expect(insert(reason)).rejects.toThrow(
      "CHECK constraint failed: blocked_reason IS NULL OR blocked_reason = 'refused'",
    );
  }
});

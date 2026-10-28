import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { suspendLink } from "./status";
import { createStoredLink } from "./testFixtures";

function readLink(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT status, status_reason, updated_at FROM links`);
}

describe("suspending a link", () => {
  test("records the reason once, so a signal delivered again changes nothing", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    const changes = [];
    for (const now of [60_000, 120_000]) {
      changes.push(
        await database.write((transaction) => suspendLink(transaction, "link", "bot_removed", now)),
      );
    }

    expect(changes).toEqual([true, false]);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "bot_removed", updated_at: 60_000 },
    ]);
  });

  test("a link whose Toy Box channel was deleted keeps that reason, which only unlink ends", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "link", {
      status: "suspended",
      status_reason: "toybox_channel_deleted",
    });

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "bot_removed", 60_000),
    );

    expect(changed).toBe(false);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "toybox_channel_deleted", updated_at: 0 },
    ]);
  });
});

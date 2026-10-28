import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { suspendLink } from "./status";
import { createStoredLink } from "./testFixtures";

function readLink(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT status, status_reason, updated_at FROM links WHERE id = 'link'`,
  );
}

describe("suspending a link", () => {
  test("suspends it with the reason", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "toybox_channel_deleted", 60_000),
    );

    expect(changed).toBe(true);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "toybox_channel_deleted", updated_at: 60_000 },
    ]);
  });

  test("changes nothing when the link is already suspended for that reason", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await database.write((transaction) =>
      suspendLink(transaction, "link", "toybox_channel_deleted", 60_000),
    );

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "toybox_channel_deleted", 120_000),
    );

    expect(changed).toBe(false);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "toybox_channel_deleted", updated_at: 60_000 },
    ]);
  });

  test("a new reason replaces the old one", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "link", { status: "suspended", status_reason: "bot_removed" });

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "channel_archived", 60_000),
    );

    expect(changed).toBe(true);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "channel_archived", updated_at: 60_000 },
    ]);
  });

  test("a paused link is suspended too, so resuming it waits for the owner", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "link", { status: "paused" });

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "channel_made_public", 60_000),
    );

    expect(changed).toBe(true);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "channel_made_public", updated_at: 60_000 },
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

  test("changes nothing for a link that doesn't exist", async () => {
    const database = await openTestDatabase();

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "toybox_channel_deleted", 60_000),
    );

    expect(changed).toBe(false);
  });
});

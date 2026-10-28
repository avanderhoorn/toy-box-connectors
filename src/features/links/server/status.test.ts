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

function readAudit(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT at, actor, action, link_id, approval_id, subject FROM audit ORDER BY id`,
  );
}

describe("suspending a link", () => {
  test("suspends it with the reason and audits the change", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "toybox_channel_deleted", 60_000),
    );

    expect(changed).toBe(true);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "toybox_channel_deleted", updated_at: 60_000 },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        at: 60_000,
        actor: "bridge",
        action: "suspend",
        link_id: "link",
        approval_id: null,
        subject: "toybox_channel_deleted",
      },
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
    expect(await readAudit(database)).toHaveLength(1);
  });

  test("changes nothing for a link that doesn't exist", async () => {
    const database = await openTestDatabase();

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "toybox_channel_deleted", 60_000),
    );

    expect(changed).toBe(false);
    expect(await readAudit(database)).toEqual([]);
  });
});

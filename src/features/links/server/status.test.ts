import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { suspendLink } from "./status";
import { createStoredApproval, createStoredLink } from "./testFixtures";

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

function readApprovals(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT id, state, stale_reason, decided_by FROM approvals ORDER BY number`,
  );
}

function readCardUpdates(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`
      SELECT approval_id, channel_id FROM outbox
      WHERE kind = 'card' AND phase = 'update' AND state = 'queued' ORDER BY number
    `,
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

  test("stales the link's open cards, decided or not, and queues the update each card shows", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredLink(database, "other");
    await createStoredApproval(database, { id: "pending", number: 1 });
    await createStoredApproval(database, {
      id: "approved",
      number: 2,
      state: "approved",
      decidedBy: "U-owner",
      decidedAt: 30_000,
    });
    await createStoredApproval(database, {
      id: "applied",
      number: 3,
      state: "applied",
      appliedAt: 45_000,
      decidedBy: "U-owner",
      decidedAt: 30_000,
    });
    await createStoredApproval(database, {
      id: "elsewhere",
      number: 4,
      linkId: "other",
      toyboxChannelId: "toybox-other",
    });

    await database.write((transaction) => suspendLink(transaction, "link", "bot_removed", 60_000));

    expect(await readApprovals(database)).toEqual([
      { id: "pending", state: "stale", stale_reason: "link_changed", decided_by: null },
      { id: "approved", state: "stale", stale_reason: "link_changed", decided_by: "U-owner" },
      { id: "applied", state: "applied", stale_reason: null, decided_by: "U-owner" },
      { id: "elsewhere", state: "pending", stale_reason: null, decided_by: null },
    ]);
    expect(await readCardUpdates(database)).toEqual([
      { approval_id: "pending", channel_id: "C-link" },
      { approval_id: "approved", channel_id: "C-link" },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        at: 60_000,
        actor: "bridge",
        action: "suspend",
        link_id: "link",
        approval_id: null,
        subject: "bot_removed",
      },
      ...["pending", "approved"].map((id) => ({
        at: 60_000,
        actor: "bridge",
        action: "stale",
        link_id: "link",
        approval_id: id,
        subject: "link_changed",
      })),
    ]);
  });

  test("a repeated signal leaves a resume card proposed since the suspension open", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "link", { status: "suspended", status_reason: "bot_removed" });
    await createStoredApproval(database, { action: "resume" });

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "bot_removed", 60_000),
    );

    expect(changed).toBe(false);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "pending", stale_reason: null, decided_by: null },
    ]);
    expect(await readCardUpdates(database)).toEqual([]);
  });

  test("a new reason replaces the old one and stales the resume card proposed for it", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "link", { status: "suspended", status_reason: "bot_removed" });
    await createStoredApproval(database, { action: "resume" });

    const changed = await database.write((transaction) =>
      suspendLink(transaction, "link", "channel_archived", 60_000),
    );

    expect(changed).toBe(true);
    expect(await readLink(database)).toEqual([
      { status: "suspended", status_reason: "channel_archived", updated_at: 60_000 },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "link_changed", decided_by: null },
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
    expect(await readAudit(database)).toEqual([]);
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

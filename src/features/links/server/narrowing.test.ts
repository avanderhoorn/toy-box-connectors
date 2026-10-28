import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import {
  allowlistField,
  APPROVAL_LIFETIME_MS,
  type Approval,
  type StaleReason,
} from "@links/model/approvals";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { denyPerson, pauseLink, unlinkChannel } from "./narrowing";
import type { SetupCaller } from "./setup";
import { createStoredApproval, createStoredLink } from "./testFixtures";

const HOUR_MS = 60 * 60_000;
const NOW = 50 * HOUR_MS;

const lead: SetupCaller = { role: "lead", channelId: "toybox-link" };
const newChannel: SetupCaller = { role: "lead", channelId: "toybox-new" };

/** The installation, with toybox-link's link to C-link. `columns` replace the link's. */
async function linked(columns: Parameters<typeof createStoredLink>[2] = {}) {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database, "link", columns);
  return database;
}

/** A pending card toybox-link's lead proposed a minute ago, allowing U-{number}. */
function storeCard(database: BridgeDatabase, number: number, changes: Partial<Approval> = {}) {
  return createStoredApproval(database, {
    id: `approval-${number}`,
    number,
    patch: [{ field: allowlistField(`U-${number}`), after: { label: null } }],
    createdAt: NOW - 60_000,
    expiresAt: NOW - 60_000 + APPROVAL_LIFETIME_MS,
    ...changes,
  });
}

const resume = { action: "resume", patch: [{ field: "status", after: "active" }] } as const;

const approved = { state: "approved", decidedBy: "U-owner", decidedAt: NOW - 30_000 } as const;

/** A card proposing to hand ownership to `userId`. */
function handTo(userId: string) {
  return { action: "owner", patch: [{ field: "owner_user_id", after: userId }] } as const;
}

/** A card proposing to allow `userId`. */
function allowing(userId: string) {
  return { patch: [{ field: allowlistField(userId), after: { label: null } }] };
}

function voided(approval: Approval, staleReason: StaleReason = "reversed"): Approval {
  return { ...approval, state: "stale", staleReason };
}

function storeAlias(database: BridgeDatabase, aliasId: string, userId: string) {
  return database.write(
    (transaction) => transaction`INSERT INTO user_aliases VALUES (${aliasId}, ${userId})`,
  );
}

function storeAllowed(database: BridgeDatabase, linkId: string, userIds: readonly string[]) {
  return database.write(async (transaction) => {
    for (const userId of userIds) {
      await transaction`
        INSERT INTO allowlist (link_id, user_id, added_at) VALUES (${linkId}, ${userId}, 0)
      `;
    }
  });
}

/** An active request `requesterUserId` asked of `linkId`'s lead in a thread of its own. */
function storeAsk(
  database: BridgeDatabase,
  requesterUserId: string,
  root: number,
  linkId = "link",
) {
  const rootTs = `1700000${root}00.000100`;
  return createStoredRequest(database, { linkId, requesterUserId, rootTs, sourceTs: rootTs });
}

async function readLinks(database: BridgeDatabase) {
  return [
    ...(await database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`)),
  ];
}

async function readApprovals(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`SELECT id, state, stale_reason FROM approvals ORDER BY number`,
    )),
  ];
}

async function readAllowed(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`SELECT link_id, user_id FROM allowlist ORDER BY link_id, user_id`,
    )),
  ];
}

async function readRequests(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`
        SELECT id, link_id, requester_user_id, state, closed_reason FROM requests ORDER BY id
      `,
    )),
  ];
}

async function readOutbox(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`
        SELECT kind, phase, state, link_id, approval_id, request_id, payload FROM outbox
        ORDER BY number
      `,
    )),
  ];
}

async function readAudit(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`SELECT actor, action, link_id, approval_id, subject FROM audit ORDER BY id`,
    )),
  ];
}

function staled(
  approvalId: string,
  reason: StaleReason = "reversed",
  linkId: string | null = "link",
) {
  return {
    actor: "bridge",
    action: "stale",
    link_id: linkId,
    approval_id: approvalId,
    subject: reason,
  };
}

describe("pausing", () => {
  test("refuses a Toy Box channel without a link, whatever other channels link", async () => {
    const database = await linked();

    expect(await pauseLink(database, newChannel, NOW)).toEqual({
      kind: "refused",
      reason: "not_linked",
    });
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "active", status_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([]);
  });

  test("stops an active link and voids its open cards, which were decided against its status", async () => {
    const database = await linked();
    await createStoredLink(database, "other");
    const pending = await storeCard(database, 1);
    const deciding = await storeCard(database, 2, approved);
    await storeCard(database, 3, { createdAt: 0, expiresAt: NOW });
    await storeCard(database, 4, { toyboxChannelId: "toybox-other", linkId: "other" });

    expect(await pauseLink(database, lead, NOW)).toEqual({
      kind: "paused",
      status: "paused",
      voided: [voided(pending, "link_changed"), voided(deciding, "link_changed")],
    });
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "paused", status_reason: null },
      { id: "other", status: "active", status_reason: null },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "link_changed" },
      { id: "approval-2", state: "stale", stale_reason: "link_changed" },
      { id: "approval-3", state: "expired", stale_reason: null },
      { id: "approval-4", state: "pending", stale_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "bridge",
        action: "expire",
        link_id: "link",
        approval_id: "approval-3",
        subject: null,
      },
      { actor: "lead", action: "pause", link_id: "link", approval_id: null, subject: null },
      staled("approval-1", "link_changed"),
      staled("approval-2", "link_changed"),
    ]);
  });

  test.each([
    ["waiting for the owner", {}],
    ["the owner approved", approved],
  ])("a paused link voids a card that would resume it %s, and only that card", async (_, state) => {
    const database = await linked({ status: "paused" });
    const resuming = await storeCard(database, 1, { ...resume, ...state });
    await storeCard(database, 2);

    expect(await pauseLink(database, lead, NOW)).toEqual({
      kind: "paused",
      status: "paused",
      voided: [voided(resuming)],
    });
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "paused", status_reason: null },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "reversed" },
      { id: "approval-2", state: "pending", stale_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([
      { actor: "lead", action: "pause", link_id: "link", approval_id: null, subject: null },
      staled("approval-1"),
    ]);
  });

  test("a suspended link stays suspended, with its reason, and the card that would resume it is voided", async () => {
    const database = await linked({ status: "suspended", status_reason: "channel_id_changed" });
    const resuming = await storeCard(database, 1, resume);

    expect(await pauseLink(database, { role: "operator", channelId: "toybox-link" }, NOW)).toEqual({
      kind: "paused",
      status: "suspended",
      voided: [voided(resuming)],
    });
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "channel_id_changed" },
    ]);
    expect(await readAudit(database)).toEqual([
      { actor: "operator", action: "pause", link_id: "link", approval_id: null, subject: null },
      staled("approval-1"),
    ]);
  });

  test.each([
    ["paused", null],
    ["suspended", "channel_id_changed"],
  ] as const)("a %s link that no card would resume is unchanged", async (status, reason) => {
    const database = await linked({ status, status_reason: reason });
    await storeCard(database, 1);
    await storeCard(database, 2, { ...resume, createdAt: 0, expiresAt: NOW });
    await createStoredLink(database, "other", { status: "paused" });
    await storeCard(database, 3, { ...resume, toyboxChannelId: "toybox-other", linkId: "other" });

    expect(await pauseLink(database, lead, NOW)).toEqual({ kind: "unchanged", status });
    expect(await readLinks(database)).toEqual([
      { id: "link", status, status_reason: reason },
      { id: "other", status: "paused", status_reason: null },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "pending", stale_reason: null },
      { id: "approval-2", state: "expired", stale_reason: null },
      { id: "approval-3", state: "pending", stale_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "bridge",
        action: "expire",
        link_id: "link",
        approval_id: "approval-2",
        subject: null,
      },
    ]);
  });
});

describe("denying", () => {
  test.each(["U-owner", "W-owner"])(
    "refuses to deny the owner as %s, whether the channel is linked or not",
    async (userId) => {
      const database = await linked();
      await storeAlias(database, "W-owner", "U-owner");
      await storeCard(database, 1, allowing("W-owner"));

      expect(await denyPerson(database, lead, userId, NOW)).toEqual({
        kind: "refused",
        reason: "owner",
      });
      expect(await denyPerson(database, newChannel, userId, NOW)).toEqual({
        kind: "refused",
        reason: "owner",
      });
      expect(await readApprovals(database)).toEqual([
        { id: "approval-1", state: "pending", stale_reason: null },
      ]);
      expect(await readAudit(database)).toEqual([]);
    },
  );

  test.each(["U-owner", "W-owner"])(
    "refuses to deny the owner as %s once Slack has given them an ID since the one they claimed with",
    async (userId) => {
      const database = await linked();
      // The installation still names the owner U-owner, which is now an alias of W-owner.
      await storeAlias(database, "U-owner", "W-owner");

      expect(await denyPerson(database, lead, userId, NOW)).toEqual({
        kind: "refused",
        reason: "owner",
      });
      expect(await readAudit(database)).toEqual([]);
    },
  );

  test("refuses a Toy Box channel without a link when no card would make the person owner", async () => {
    const database = await linked();
    await storeAllowed(database, "link", ["U-carol"]);
    await storeCard(database, 1, allowing("U-carol"));
    await storeAsk(database, "U-carol", 1);

    expect(await denyPerson(database, newChannel, "U-carol", NOW)).toEqual({
      kind: "refused",
      reason: "not_linked",
    });
    expect(await readAllowed(database)).toEqual([{ link_id: "link", user_id: "U-carol" }]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "pending", stale_reason: null },
    ]);
    expect((await readRequests(database)).map((request) => request.state)).toEqual(["open"]);
    expect(await readAudit(database)).toEqual([]);
  });

  test("takes the person off the allowlist under every ID, cancels only their requests and voids the cards that would allow them", async () => {
    const database = await linked();
    await createStoredLink(database, "other");
    await storeAlias(database, "W-carol", "U-carol");
    await storeAllowed(database, "link", ["U-carol", "U-dave", "W-carol"]);
    await storeAllowed(database, "other", ["U-carol"]);
    const byId = await storeCard(database, 1, allowing("U-carol"));
    await storeCard(database, 2, allowing("U-dave"));
    const byAlias = await storeCard(database, 3, { ...allowing("W-carol"), ...approved });
    await storeCard(database, 4, {
      ...allowing("U-carol"),
      toyboxChannelId: "toybox-other",
      linkId: "other",
    });
    await storeAsk(database, "U-carol", 1);
    await storeAsk(database, "U-dave", 2);
    await storeAsk(database, "W-carol", 3);
    await storeAsk(database, "U-carol", 4, "other");

    expect(await denyPerson(database, lead, "W-carol", NOW)).toEqual({
      kind: "denied",
      removed: true,
      voided: [voided(byId), voided(byAlias)],
      cancelled: [1, 3],
    });
    expect(await readAllowed(database)).toEqual([
      { link_id: "link", user_id: "U-dave" },
      { link_id: "other", user_id: "U-carol" },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "reversed" },
      { id: "approval-2", state: "pending", stale_reason: null },
      { id: "approval-3", state: "stale", stale_reason: "reversed" },
      { id: "approval-4", state: "pending", stale_reason: null },
    ]);
    expect(await readRequests(database)).toEqual([
      {
        id: 1,
        link_id: "link",
        requester_user_id: "U-carol",
        state: "cancelled",
        closed_reason: "requester_denied",
      },
      { id: 2, link_id: "link", requester_user_id: "U-dave", state: "open", closed_reason: null },
      {
        id: 3,
        link_id: "link",
        requester_user_id: "W-carol",
        state: "cancelled",
        closed_reason: "requester_denied",
      },
      { id: 4, link_id: "other", requester_user_id: "U-carol", state: "open", closed_reason: null },
    ]);
    expect(
      (await readOutbox(database)).map(({ kind, phase, approval_id, request_id }) => ({
        kind,
        phase,
        approval_id,
        request_id,
      })),
    ).toEqual([
      { kind: "reaction", phase: null, approval_id: null, request_id: 1 },
      { kind: "reaction", phase: null, approval_id: null, request_id: 3 },
      { kind: "card", phase: "update", approval_id: "approval-1", request_id: null },
      { kind: "card", phase: "update", approval_id: "approval-3", request_id: null },
    ]);
    expect(await readAudit(database)).toEqual([
      { actor: "lead", action: "deny", link_id: "link", approval_id: null, subject: "U-carol" },
      staled("approval-1"),
      staled("approval-3"),
    ]);
  });

  test("voids every card that would make the person owner, whichever Toy Box channel asked", async () => {
    const database = await linked();
    await createStoredLink(database, "other");
    await storeAlias(database, "W-carol", "U-carol");
    const fromOther = await storeCard(database, 1, {
      ...handTo("U-carol"),
      toyboxChannelId: "toybox-other",
      linkId: "other",
    });
    const byAlias = await storeCard(database, 2, { ...handTo("W-carol"), ...approved });
    await storeCard(database, 3, handTo("U-dave"));

    expect(await denyPerson(database, newChannel, "U-carol", NOW)).toEqual({
      kind: "denied",
      removed: false,
      voided: [voided(fromOther), voided(byAlias)],
      cancelled: [],
    });
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "reversed" },
      { id: "approval-2", state: "stale", stale_reason: "reversed" },
      { id: "approval-3", state: "pending", stale_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([
      { actor: "lead", action: "deny", link_id: null, approval_id: null, subject: "U-carol" },
      staled("approval-1", "reversed", "other"),
      staled("approval-2"),
    ]);
  });

  test.each<[string, { allowed?: boolean; asked?: boolean; proposed?: boolean }, boolean]>([
    ["is allowed", { allowed: true }, true],
    ["has asked", { asked: true }, false],
    ["is proposed", { proposed: true }, false],
  ])("denying someone who only %s still denies them", async (_, given, removed) => {
    const database = await linked();
    if (given.allowed) await storeAllowed(database, "link", ["U-carol"]);
    const asked = given.asked ? [(await storeAsk(database, "U-carol", 1)).id] : [];
    const card = given.proposed ? [await storeCard(database, 1, allowing("U-carol"))] : [];

    expect(await denyPerson(database, lead, "U-carol", NOW)).toEqual({
      kind: "denied",
      removed,
      voided: card.map((approval) => voided(approval)),
      cancelled: asked,
    });
    expect(await readAllowed(database)).toEqual([]);
    expect((await readAudit(database)).map((entry) => entry.action)).toEqual([
      "deny",
      ...card.map(() => "stale"),
    ]);
  });

  test("someone not allowed, with nothing asked and no card for them, is unchanged", async () => {
    const database = await linked();
    await createStoredLink(database, "other");
    await storeAllowed(database, "link", ["U-dave"]);
    await storeAllowed(database, "other", ["U-carol"]);
    await storeCard(database, 1, allowing("U-dave"));
    await storeCard(database, 2, { ...allowing("U-carol"), createdAt: 0, expiresAt: NOW });
    await storeAsk(database, "U-dave", 1);
    await storeAsk(database, "U-carol", 2, "other");

    expect(await denyPerson(database, lead, "U-carol", NOW)).toEqual({ kind: "unchanged" });
    expect(await readAllowed(database)).toEqual([
      { link_id: "link", user_id: "U-dave" },
      { link_id: "other", user_id: "U-carol" },
    ]);
    expect((await readRequests(database)).map((request) => request.state)).toEqual([
      "open",
      "open",
    ]);
    expect((await readAudit(database)).map((entry) => entry.action)).toEqual(["expire"]);
  });
});

describe("unlinking", () => {
  test("refuses a Toy Box channel with no link and no card that would make one", async () => {
    const database = await linked();
    await storeCard(database, 1);

    expect(await unlinkChannel(database, newChannel, NOW, createTestFolder())).toEqual({
      kind: "refused",
      reason: "not_linked",
    });
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "active", status_reason: null },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "pending", stale_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([]);
  });

  test("a Toy Box channel with no link voids the card that would make one", async () => {
    const database = await linked();
    const linking = await storeCard(database, 1, {
      toyboxChannelId: "toybox-new",
      linkId: null,
      action: "link",
      ...approved,
    });
    await storeCard(database, 2);

    expect(await unlinkChannel(database, newChannel, NOW, createTestFolder())).toEqual({
      kind: "unlinked",
      linkId: null,
      voided: [voided(linking)],
      cancelled: [],
    });
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "active", status_reason: null },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "reversed" },
      { id: "approval-2", state: "pending", stale_reason: null },
    ]);
    expect(await readAudit(database)).toEqual([
      { actor: "lead", action: "unlink", link_id: null, approval_id: null, subject: null },
      staled("approval-1", "reversed", null),
    ]);
  });

  test("removes the link, cancels its requests and voids its cards, keeping only what Slack may still settle", async () => {
    const database = await linked({ status: "suspended", status_reason: "channel_id_changed" });
    await createStoredLink(database, "other");
    const posted = await storeCard(database, 1);
    const unposted = await storeCard(database, 2, { card: { channelId: "C-link", ts: null } });
    await storeCard(database, 3, { toyboxChannelId: "toybox-other", linkId: "other" });
    await createStoredOutboxItem(database, 1, {
      kind: "card",
      phase: "post",
      approval_id: "approval-2",
      link_id: null,
      request_id: null,
      request_rev: null,
      thread_ts: null,
    });
    await storeAllowed(database, "link", ["U-carol"]);
    await storeAllowed(database, "other", ["U-carol"]);
    await storeAsk(database, "U-carol", 1);
    await storeAsk(database, "U-carol", 2, "other");
    await createStoredOutboxItem(database, 2);
    await createStoredOutboxItem(database, 3, {
      phase: "follow_up",
      payload: JSON.stringify({ text: "Here's the deploy log." }),
      state: "sending",
      attempts: 1,
      attempt_method: "chat.postMessage",
    });
    await createStoredOutboxItem(database, 4, {
      link_id: "other",
      request_id: 2,
      channel_id: "C-other",
    });
    const folder = createTestFolder();
    for (const path of ["F-link/report.pdf", "F-other/notes.txt"]) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), "copy");
    }
    await database.write(
      (transaction) => transaction`
        INSERT INTO files (file_id, channel_id, ts, state, local_path, fetched_at) VALUES
          ('F-link', 'C-link', '1700000100.000100', 'fetched', 'F-link/report.pdf', 0),
          ('F-other', 'C-other', '1700000100.000100', 'fetched', 'F-other/notes.txt', 0)
      `,
    );

    expect(await unlinkChannel(database, lead, NOW, folder)).toEqual({
      kind: "unlinked",
      linkId: "link",
      voided: [voided(posted), voided(unposted)],
      cancelled: [1],
    });
    expect(await readLinks(database)).toEqual([
      { id: "other", status: "active", status_reason: null },
    ]);
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", state: "stale", stale_reason: "reversed" },
      { id: "approval-3", state: "pending", stale_reason: null },
    ]);
    expect(await readAllowed(database)).toEqual([{ link_id: "other", user_id: "U-carol" }]);
    expect((await readRequests(database)).map((request) => request.id)).toEqual([2]);
    expect(await readOutbox(database)).toEqual([
      {
        kind: "reply",
        phase: "follow_up",
        state: "sending",
        link_id: "link",
        approval_id: null,
        request_id: 1,
        payload: JSON.stringify({ redacted: "unlink" }),
      },
      {
        kind: "reply",
        phase: "final",
        state: "queued",
        link_id: "other",
        approval_id: null,
        request_id: 2,
        payload: "{}",
      },
      {
        kind: "card",
        phase: "update",
        state: "queued",
        link_id: "link",
        approval_id: "approval-1",
        request_id: null,
        payload: "{}",
      },
      {
        kind: "reaction",
        phase: null,
        state: "queued",
        link_id: "link",
        approval_id: null,
        request_id: 1,
        payload: JSON.stringify({ action: "remove", name: "eyes", timestamp: "1700000100.000100" }),
      },
    ]);
    expect(await database.read((sql) => sql`SELECT file_id FROM files ORDER BY file_id`)).toEqual([
      { file_id: "F-other" },
    ]);
    expect(existsSync(join(folder, "F-link/report.pdf"))).toBe(false);
    expect(existsSync(join(folder, "F-other/notes.txt"))).toBe(true);
    expect(await readAudit(database)).toEqual([
      { actor: "lead", action: "unlink", link_id: "link", approval_id: null, subject: null },
      staled("approval-1"),
      staled("approval-2"),
    ]);
  });
});

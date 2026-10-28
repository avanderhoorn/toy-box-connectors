import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { APPROVAL_LIFETIME_MS, APPROVE_ACTION_ID, REJECT_ACTION_ID } from "@links/model/approvals";
import { pendingApproval } from "@links/model/testFixtures";
import { slackPerson } from "@slackapi/model/testFixtures";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { writeSlackPerson } from "@slackapi/server/users";
import {
  countProposalsSince,
  createApproval,
  expireApprovals,
  type IgnoredInteraction,
  readAllOpenApprovals,
  readApproval,
  recordCardPosted,
  takeClick,
} from "./approvals";
import { createStoredApproval } from "./testFixtures";

/** U-owner's click on `actionId` on approval-1's card, as Slack sends it. `changes` replace its fields. */
function click(changes: Record<string, unknown> = {}, actionId = APPROVE_ACTION_ID) {
  return {
    type: "block_actions",
    api_app_id: "A-app",
    team: { id: "T-home", domain: "home" },
    user: { id: "U-owner", username: "owner", team_id: "T-home" },
    trigger_id: "1.2.3",
    container: {
      type: "message",
      message_ts: "1000.000100",
      channel_id: "C-link",
      is_ephemeral: false,
    },
    actions: [
      {
        type: "button",
        action_id: actionId,
        block_id: "decide",
        value: "approval-1",
        action_ts: "1000.000200",
      },
    ],
    ...changes,
  };
}

/** An installation owned by U-owner, with approval-1 pending on its card. */
async function pendingCard(changes: Parameters<typeof pendingApproval>[0] = {}) {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredApproval(database, changes);
  return database;
}

function take(database: BridgeDatabase, payload: unknown, now = 60_000) {
  return database.write((transaction) => takeClick(transaction, payload, now));
}

async function readState(database: BridgeDatabase) {
  const [row] = await database.read(
    (sql) => sql`SELECT state, decided_by, decided_at FROM approvals WHERE id = 'approval-1'`,
  );
  return row;
}

async function readAudit(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`SELECT actor, action, link_id, approval_id, subject FROM audit ORDER BY id`,
    )),
  ];
}

async function readOutbox(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) =>
        sql`SELECT kind, phase, approval_id, link_id, channel_id FROM outbox ORDER BY number`,
    )),
  ];
}

const cardUpdate = {
  kind: "card",
  phase: "update",
  approval_id: "approval-1",
  link_id: "link",
  channel_id: "C-link",
};

describe("taking a click", () => {
  test("the owner's Approve approves the card before the ack, queues its update and audits it", async () => {
    const database = await pendingCard();

    expect(await take(database, click())).toEqual({
      kind: "settled",
      approvalId: "approval-1",
      state: "approved",
    });

    expect(await readState(database)).toEqual({
      state: "approved",
      decided_by: "U-owner",
      decided_at: 60_000,
    });
    expect(await readOutbox(database)).toEqual([cardUpdate]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "owner",
        action: "approve",
        link_id: "link",
        approval_id: "approval-1",
        subject: "U-owner",
      },
    ]);
  });

  test("the owner's Reject rejects it the same way", async () => {
    const database = await pendingCard();

    expect(await take(database, click({}, REJECT_ACTION_ID))).toMatchObject({
      kind: "settled",
      state: "rejected",
    });

    expect(await readState(database)).toEqual({
      state: "rejected",
      decided_by: "U-owner",
      decided_at: 60_000,
    });
    expect(await readOutbox(database)).toEqual([cardUpdate]);
    expect(await readAudit(database)).toMatchObject([{ actor: "owner", action: "reject" }]);
  });

  test("a click under the owner's org-wide ID counts as theirs", async () => {
    const database = await pendingCard();
    const owner = slackPerson({
      id: "U-owner",
      enterpriseId: "E-org",
      enterpriseUserId: "W-owner",
    });
    await database.write((transaction) => writeSlackPerson(transaction, owner, 1_000));

    expect(await take(database, click({ user: { id: "W-owner" } }))).toMatchObject({
      kind: "settled",
      state: "approved",
    });
    expect(await readState(database)).toMatchObject({ decided_by: "U-owner" });
  });

  test("a stranger's click changes nothing, so the card stays pending, and the audit names them", async () => {
    const database = await pendingCard();
    const mallory = slackPerson({ id: "U-mallory", enterpriseUserId: "W-mallory" });
    await database.write((transaction) => writeSlackPerson(transaction, mallory, 1_000));

    for (const user of ["U-mallory", "W-mallory", "W-owner"]) {
      expect(await take(database, click({ user: { id: user } }))).toEqual({
        kind: "ignored",
        reason: "not_owner",
      });
    }

    expect(await readState(database)).toEqual({
      state: "pending",
      decided_by: null,
      decided_at: null,
    });
    expect(await readOutbox(database)).toEqual([]);
    const refused = { actor: "bridge", action: "refuse_click", link_id: "link" };
    expect(await readAudit(database)).toEqual([
      { ...refused, approval_id: "approval-1", subject: "U-mallory" },
      { ...refused, approval_id: "approval-1", subject: "U-mallory" },
      { ...refused, approval_id: "approval-1", subject: "W-owner" },
    ]);
  });

  test("a redelivered click finds its decision made and does nothing", async () => {
    const database = await pendingCard();
    await take(database, click());

    expect(await take(database, click(), 61_000)).toEqual({ kind: "unchanged" });
    expect(await take(database, click({}, REJECT_ACTION_ID), 62_000)).toEqual({
      kind: "unchanged",
    });

    expect(await readState(database)).toEqual({
      state: "approved",
      decided_by: "U-owner",
      decided_at: 60_000,
    });
    expect(await readOutbox(database)).toEqual([cardUpdate]);
    expect(await readAudit(database)).toMatchObject([{ action: "approve" }]);
  });

  test("the owner's click after the hour expires the card, so the lead hears the outcome", async () => {
    const database = await pendingCard();

    expect(await take(database, click(), APPROVAL_LIFETIME_MS)).toMatchObject({
      kind: "settled",
      state: "expired",
    });

    expect(await readState(database)).toEqual({
      state: "expired",
      decided_by: "U-owner",
      decided_at: APPROVAL_LIFETIME_MS,
    });
    expect(await readOutbox(database)).toEqual([cardUpdate]);
    expect(await readAudit(database)).toMatchObject([{ actor: "owner", action: "expire" }]);
  });

  test("anything but a click on a pending card of ours changes nothing, and is audited", async () => {
    const button = click().actions[0]!;
    const container = click().container;
    // The audit names the approval a click names, whenever there's one by that ID.
    const cases: { payload: unknown; reason: IgnoredInteraction; named: boolean }[] = [
      { payload: click({ api_app_id: "A-other" }), reason: "wrong_app", named: true },
      { payload: click({ team: { id: "T-other" } }), reason: "wrong_app", named: true },
      {
        payload: click({ team: null, is_enterprise_install: true }),
        reason: "wrong_app",
        named: true,
      },
      { payload: click({}, "approval.maybe"), reason: "unknown_action", named: true },
      { payload: click({ actions: [button, button] }), reason: "unknown_action", named: false },
      { payload: click({ actions: [] }), reason: "unknown_action", named: false },
      {
        payload: click({ actions: [{ ...button, value: "approval-2" }] }),
        reason: "unknown_card",
        named: false,
      },
      {
        payload: click({ container: { ...container, channel_id: "C-other" } }),
        reason: "unknown_card",
        named: true,
      },
      {
        payload: click({ container: { ...container, message_ts: "1000.000300" } }),
        reason: "unknown_card",
        named: true,
      },
      {
        payload: click({ container: { ...container, is_ephemeral: true } }),
        reason: "unknown_card",
        named: true,
      },
      { payload: { type: "shortcut", callback_id: "x" }, reason: "not_a_click", named: false },
      { payload: click({ user: { name: "owner" } }), reason: "malformed", named: false },
      { payload: "approve", reason: "malformed", named: false },
    ];
    for (const { payload, reason, named } of cases) {
      const database = await pendingCard();

      expect(await take(database, payload)).toEqual({ kind: "ignored", reason });

      expect(await readState(database)).toMatchObject({ state: "pending" });
      expect(await readOutbox(database)).toEqual([]);
      expect(await readAudit(database)).toEqual([
        {
          actor: "bridge",
          action: "ignore_click",
          link_id: named ? "link" : null,
          approval_id: named ? "approval-1" : null,
          subject: reason,
        },
      ]);
    }
  });

  test("with no installation, nothing can be decided", async () => {
    const database = await openTestDatabase();
    await createStoredApproval(database);

    expect(await take(database, click())).toEqual({ kind: "ignored", reason: "wrong_app" });
    expect(await readState(database)).toMatchObject({ state: "pending" });
  });

  test("while Slack rejects the tokens, the owner's click waits for them to click again", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database, { status: "auth_failed" });
    await createStoredApproval(database);

    expect(await take(database, click())).toEqual({ kind: "ignored", reason: "not_connected" });

    expect(await readState(database)).toMatchObject({ state: "pending" });
    expect(await readOutbox(database)).toEqual([]);
    expect(await readAudit(database)).toMatchObject([
      { action: "ignore_click", approval_id: "approval-1", subject: "not_connected" },
    ]);
  });
});

describe("posting a card", () => {
  test("a card counts only once the outbox records its ts, and keeps the first", async () => {
    const database = await pendingCard({ card: { channelId: "C-link", ts: null } });
    expect(await take(database, click())).toEqual({ kind: "ignored", reason: "unknown_card" });

    const record = (ts: string) =>
      database.write((transaction) => recordCardPosted(transaction, "approval-1", ts));
    expect(await record("1000.000100")).toBe(true);
    expect(await record("1000.000900")).toBe(false);
    expect(await database.read((sql) => readApproval(sql, "approval-1"))).toMatchObject({
      card: { channelId: "C-link", ts: "1000.000100" },
    });

    expect(await take(database, click(), 61_000)).toMatchObject({
      kind: "settled",
      state: "approved",
    });
  });
});

describe("reading an approval", () => {
  test("reads back as it was stored, or null when there's no such approval", async () => {
    const database = await openTestDatabase();
    const approval = await createStoredApproval(database, {
      state: "stale",
      staleReason: "audience_changed",
      decidedBy: "U-owner",
      decidedAt: 5,
      reportedAt: 9,
    });

    expect(await database.read((sql) => readApproval(sql, "approval-1"))).toEqual(approval);
    expect(await database.read((sql) => readApproval(sql, "approval-2"))).toBeNull();
  });
});

describe("making a proposal", () => {
  const proposal = {
    toyboxChannelId: "toybox-link",
    linkId: "link",
    action: "allow",
    patch: [{ field: "allowlist.U-carol", after: { label: null } }],
    readSet: pendingApproval().readSet,
    cardChannelId: "C-link",
    createdBy: "lead",
  } as const;

  test("takes the number after every channel's, an ID nobody can guess, and an hour", async () => {
    const database = await openTestDatabase();
    await createStoredApproval(database, {
      id: "approval-7",
      number: 7,
      toyboxChannelId: "toybox-other",
      state: "expired",
    });
    const create = () =>
      database.write((transaction) => createApproval(transaction, proposal, 60_000));

    const first = await create();
    const second = await create();

    expect(first).toEqual({
      ...pendingApproval(),
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      number: 8,
      card: { channelId: "C-link", ts: null },
      createdAt: 60_000,
      expiresAt: 60_000 + APPROVAL_LIFETIME_MS,
    });
    expect(second.number).toBe(9);
    expect(second.id).not.toBe(first.id);
    expect(await database.read((sql) => readApproval(sql, first.id))).toEqual(first);
    expect(await readOutbox(database)).toEqual([
      { kind: "card", phase: "post", approval_id: first.id, link_id: "link", channel_id: "C-link" },
      {
        kind: "card",
        phase: "post",
        approval_id: second.id,
        link_id: "link",
        channel_id: "C-link",
      },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "lead",
        action: "propose",
        link_id: "link",
        approval_id: first.id,
        subject: "allow",
      },
      {
        actor: "lead",
        action: "propose",
        link_id: "link",
        approval_id: second.id,
        subject: "allow",
      },
    ]);
  });
});

describe("reading proposals", () => {
  test("open approvals are those waiting for the owner or apply, from every channel, oldest first", async () => {
    const database = await openTestDatabase();
    const states = ["approved", "applied", "pending", "rejected", "expired", "stale"] as const;
    for (const [index, state] of states.entries()) {
      await createStoredApproval(database, {
        id: `approval-${index + 1}`,
        number: 10 - index,
        toyboxChannelId: `toybox-${index}`,
        linkId: `link-${index}`,
        state,
        staleReason: state === "stale" ? "reversed" : null,
        appliedAt: state === "applied" ? 3 : null,
        decidedBy: ["approved", "applied", "rejected"].includes(state) ? "U-owner" : null,
        decidedAt: ["approved", "applied", "rejected"].includes(state) ? 2 : null,
      });
    }

    const open = await database.read((sql) => readAllOpenApprovals(sql));
    expect(open.map((approval) => [approval.id, approval.state])).toEqual([
      ["approval-3", "pending"],
      ["approval-1", "approved"],
    ]);
  });

  test("a channel's proposals since a moment count whatever became of them, and only its own", async () => {
    const database = await openTestDatabase();
    const created = [
      { toyboxChannelId: "toybox-link", createdAt: 100, state: "pending" },
      { toyboxChannelId: "toybox-link", createdAt: 101, state: "expired" },
      { toyboxChannelId: "toybox-link", createdAt: 102, state: "stale", staleReason: "reversed" },
      { toyboxChannelId: "toybox-other", createdAt: 103, state: "pending" },
    ] as const;
    for (const [index, changes] of created.entries()) {
      await createStoredApproval(database, {
        id: `approval-${index}`,
        number: index + 1,
        ...changes,
      });
    }
    const count = (channelId: string, since: number) =>
      database.read((sql) => countProposalsSince(sql, channelId, since));

    expect(await count("toybox-link", 99)).toBe(3);
    expect(await count("toybox-link", 100)).toBe(2);
    expect(await count("toybox-link", 102)).toBe(0);
    expect(await count("toybox-other", 0)).toBe(1);
    expect(await count("toybox-new", 0)).toBe(0);
  });
});

describe("expiring proposals", () => {
  test("a pending card expires once its hour is up, showing it on the card, and nothing else does", async () => {
    const database = await openTestDatabase();
    await createStoredApproval(database);
    await createStoredApproval(database, {
      id: "approval-2",
      number: 2,
      expiresAt: APPROVAL_LIFETIME_MS + 1,
    });
    await createStoredApproval(database, {
      id: "approval-3",
      number: 3,
      state: "approved",
      decidedBy: "U-owner",
      decidedAt: 2,
    });
    const expire = (now: number) =>
      database.write((transaction) => expireApprovals(transaction, now));

    expect(await expire(APPROVAL_LIFETIME_MS - 1)).toEqual([]);
    expect(await expire(APPROVAL_LIFETIME_MS)).toEqual([pendingApproval({ state: "expired" })]);
    expect(await expire(APPROVAL_LIFETIME_MS)).toEqual([]);

    expect(await readState(database)).toEqual({
      state: "expired",
      decided_by: null,
      decided_at: null,
    });
    expect(await database.read((sql) => readAllOpenApprovals(sql))).toMatchObject([
      { id: "approval-2", state: "pending" },
      { id: "approval-3", state: "approved" },
    ]);
    expect(await readOutbox(database)).toEqual([cardUpdate]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "bridge",
        action: "expire",
        link_id: "link",
        approval_id: "approval-1",
        subject: null,
      },
    ]);
  });
});

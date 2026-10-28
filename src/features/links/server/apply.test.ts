import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import {
  APPLY_VERIFY_MS,
  APPROVAL_LIFETIME_MS,
  APPROVE_ACTION_ID,
  type Approval,
  type StaleReason,
} from "@links/model/approvals";
import type { Audience } from "@links/model/audience";
import type { SetupRequest } from "@links/model/setup";
import { privateAudience } from "@links/model/testFixtures";
import { channelFacts, slackPerson } from "@slackapi/model/testFixtures";
import { tsAt } from "@slackapi/model/ts";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import type { ToyBoxChannelView } from "@toybox/model/stream";
import { verifyAndApply, type ApplyAttempt } from "./apply";
import { readApproval, recordCardPosted, staleApprovals, takeClick } from "./approvals";
import type { FactsReader, Unverified } from "./facts";
import { changeSetup, type SetupCaller } from "./setup";
import {
  createStoredApproval,
  createStoredLink,
  fakeFactsReader,
  requestsRoutine,
  type FactsWorld,
} from "./testFixtures";

const HOUR_MS = 60 * 60_000;
const PROPOSED = 50 * HOUR_MS;
/** When the owner approved, a minute after the proposal. */
const CLICKED = PROPOSED + 60_000;
const NOW = CLICKED + 60_000;
const CARD_TS = "1000.000100";

/**
 * A Copilot lead's channel whose owner posted just before the proposal, with the routines
 * createStoredLink's link and a link of C-new run. `changes` replace its parts.
 */
function toyBoxView(changes: Partial<ToyBoxChannelView> = {}): ToyBoxChannelView {
  return {
    provider: "copilot",
    ownerSpokeAt: PROPOSED - 60_000,
    routines: [requestsRoutine("routine-link"), requestsRoutine("routine-new")],
    ...changes,
  };
}

/**
 * The Toy Box channel as toyBoxView shows it, and the private channels C-link, which U-dave is in
 * too, and C-new (#release-eng), with the owner and the bot in each. U-carol and U-dave are full
 * members of T-home. `changes` replace its parts.
 */
function world(changes: Partial<FactsWorld> = {}): FactsWorld {
  return {
    toyBox: toyBoxView(),
    slack: null,
    channels: {
      "C-link": channelFacts(),
      "C-new": channelFacts({ id: "C-new", name: "release-eng" }),
    },
    members: { "C-link": ["U-owner", "U-dave"], "C-new": ["U-owner"] },
    people: {
      "U-carol": slackPerson(),
      "U-dave": slackPerson({ id: "U-dave", displayName: "dave", realName: "Dave Diaz" }),
    },
    ...changes,
  };
}

/** The installation, with toybox-link's link to C-link. `columns` replace the link's. */
async function linked(columns: Parameters<typeof createStoredLink>[2] = {}) {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database, "link", columns);
  return database;
}

const lead: SetupCaller = { role: "lead", channelId: "toybox-link" };
const newChannel: SetupCaller = { role: "lead", channelId: "toybox-new" };

const allowCarol: SetupRequest = { action: "allow", userIds: ["U-carol"] };

const linkNew: SetupRequest = {
  action: "link",
  slackChannelId: "C-new",
  routineId: "routine-new",
  allow: ["U-carol"],
};

/** The owner's click on Approve on `approval`'s card, as Slack sends it. */
function approveClick(approval: Approval) {
  return {
    type: "block_actions",
    api_app_id: "A-app",
    team: { id: "T-home", domain: "home" },
    user: { id: "U-owner", username: "owner", team_id: "T-home" },
    trigger_id: "1.2.3",
    container: {
      type: "message",
      message_ts: CARD_TS,
      channel_id: approval.card.channelId,
      is_ephemeral: false,
    },
    actions: [
      {
        type: "button",
        action_id: APPROVE_ACTION_ID,
        block_id: "decide",
        value: approval.id,
        action_ts: "1000.000200",
      },
    ],
  };
}

/** Proposes `request` for `caller`'s Toy Box channel as Slack and Toy Box are in `facts`. */
async function propose(
  database: BridgeDatabase,
  facts: FactsWorld,
  request: SetupRequest,
  caller = lead,
): Promise<Approval> {
  const { reader } = fakeFactsReader(facts);
  const outcome = await changeSetup(database, reader, caller, request, PROPOSED);
  if (outcome.kind !== "proposed") throw new Error(`Setup was ${outcome.kind}, not a proposal.`);
  return outcome.approval;
}

/**
 * Proposes `request` as propose does, posts its card and has the owner approve it at CLICKED, as
 * the receiver does before the ack. Returns the approval as it's stored then.
 */
async function approve(
  database: BridgeDatabase,
  facts: FactsWorld,
  request: SetupRequest,
  caller = lead,
): Promise<Approval> {
  const proposal = await propose(database, facts, request, caller);
  return database.write(async (transaction) => {
    await recordCardPosted(transaction, proposal.id, CARD_TS);
    expect(await takeClick(transaction, approveClick(proposal), CLICKED)).toMatchObject({
      state: "approved",
    });
    return (await readApproval(transaction, proposal.id))!;
  });
}

function attempt(
  database: BridgeDatabase,
  reader: FactsReader,
  approval: Approval,
  at = NOW,
  signal = new AbortController().signal,
) {
  return verifyAndApply(database, reader, approval.id, { now: () => at, signal });
}

function applied(approval: Approval, at = NOW): ApplyAttempt {
  return { kind: "settled", approval: { ...approval, state: "applied", appliedAt: at } };
}

function staled(approval: Approval, reason: StaleReason): ApplyAttempt {
  return { kind: "settled", approval: { ...approval, state: "stale", staleReason: reason } };
}

async function readState(database: BridgeDatabase, approval: Approval) {
  const stored = await database.read((sql) => readApproval(sql, approval.id));
  return stored && { state: stored.state, staleReason: stored.staleReason };
}

async function readAllowlist(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`SELECT link_id, user_id, label, added_at FROM allowlist ORDER BY user_id`,
    )),
  ];
}

async function readLink(database: BridgeDatabase, toyboxChannelId = "toybox-link") {
  const [link] = await database.read(
    (sql) => sql`SELECT * FROM links WHERE toybox_channel_id = ${toyboxChannelId}`,
  );
  return link;
}

/** The card items queued for `approval`, oldest first. */
async function readCardItems(database: BridgeDatabase, approval: Approval) {
  return [
    ...(await database.read(
      (sql) => sql`
        SELECT phase, state, channel_id FROM outbox
        WHERE kind = 'card' AND approval_id = ${approval.id} ORDER BY number
      `,
    )),
  ];
}

/** What the applier audited: each change it applied and each card it marked stale. */
async function readAudit(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`
        SELECT actor, action, link_id, approval_id, subject FROM audit
        WHERE action IN ('apply', 'stale') ORDER BY id
      `,
    )),
  ];
}

/** A public channel of T-home's audience, shared with no one. */
function publicAudience(channelId: string): Audience {
  return { ...privateAudience(channelId), kind: "public" };
}

function setOwner(database: BridgeDatabase, ownerUserId: string) {
  return database.write(
    (transaction) => transaction`UPDATE installation SET owner_user_id = ${ownerUserId}`,
  );
}

describe("applying an approved change", () => {
  test("an allow puts exactly its patch in, shows it on the card and audits it as the owner's", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const link = await readLink(database);
    const { reader, reads } = fakeFactsReader(facts);

    expect(await attempt(database, reader, approval)).toEqual(applied(approval));

    expect(reads).toEqual(["toybox toybox-link", "slack C-link C-link U-owner [U-carol]"]);
    expect(await readLink(database)).toEqual(link);
    expect(await readAllowlist(database)).toEqual([
      { link_id: "link", user_id: "U-carol", label: null, added_at: NOW },
    ]);
    expect(await readState(database, approval)).toEqual({ state: "applied", staleReason: null });
    expect(await readCardItems(database, approval)).toEqual([
      { phase: "post", state: "queued", channel_id: "C-link" },
      { phase: "update", state: "superseded", channel_id: "C-link" },
      { phase: "update", state: "queued", channel_id: "C-link" },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "owner",
        action: "apply",
        link_id: "link",
        approval_id: approval.id,
        subject: "allowlist.U-carol=allowed",
      },
    ]);
  });

  test("relabeling someone allowed keeps when they were added, and the audit leaves the label out", async () => {
    const database = await linked();
    await database.write(
      (transaction) => transaction`
        INSERT INTO allowlist (link_id, user_id, label, added_at)
        VALUES ('link', 'U-carol', 'ops', 5)
      `,
    );
    const facts = world();
    const relabel: SetupRequest = { action: "allow", userIds: ["U-carol"], label: "design" };
    const approval = await approve(database, facts, relabel);

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );

    expect(await readAllowlist(database)).toEqual([
      { link_id: "link", user_id: "U-carol", label: "design", added_at: 5 },
    ]);
    expect(await readAudit(database)).toEqual([
      expect.objectContaining({ action: "apply", subject: "allowlist.U-carol=allowed" }),
    ]);
  });

  test("a link starts active from when it applies, with the settings and audiences its card showed", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    const facts = world();
    const request: SetupRequest = { ...linkNew, requestMode: "all", observe: "channel" };
    const approval = await approve(database, facts, request, newChannel);

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );

    const link = await readLink(database, "toybox-new");
    expect(link).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      toybox_channel_id: "toybox-new",
      slack_channel_id: "C-new",
      publish_channel_id: "C-new",
      request_mode: "all",
      observe: "channel",
      status: "active",
      status_reason: null,
      approved_audience: JSON.stringify({
        monitored: privateAudience("C-new"),
        publish: privateAudience("C-new"),
      }),
      requests_routine_id: "routine-new",
      routine_state: "present",
      linked_at_ts: tsAt(NOW),
      created_at: NOW,
      updated_at: NOW,
    });
    expect(await readAllowlist(database)).toEqual([
      { link_id: link.id, user_id: "U-carol", label: null, added_at: NOW },
    ]);
    expect(await readAudit(database)).toEqual(
      [
        "slack_channel_id=C-new",
        "publish_channel_id=C-new",
        "request_mode=all",
        "observe=channel",
        "requests_routine_id=routine-new",
        "allowlist.U-carol=allowed",
      ].map((subject) => ({
        actor: "owner",
        action: "apply",
        link_id: link.id,
        approval_id: approval.id,
        subject,
      })),
    );
  });

  test("a link whose requests routine no longer runs inbox is made with the routine marked drifted", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    const facts = world();
    const routine = { ...requestsRoutine("routine-new"), prompt: "Summarize the day." };
    facts.toyBox = toyBoxView({ routines: [routine] });
    const approval = await approve(database, facts, linkNew, newChannel);

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );
    expect(await readLink(database, "toybox-new")).toMatchObject({ routine_state: "drifted" });
  });

  test("moving where the link publishes approves that channel's audience, and keeps the other", async () => {
    const database = await linked();
    const facts = world();
    facts.channels["C-pub"] = channelFacts({ id: "C-pub", name: "announce", kind: "public" });
    facts.members["C-pub"] = ["U-owner"];
    const move: SetupRequest = { action: "set", change: { publishChannelId: "C-pub" } };
    const approval = await approve(database, facts, move);

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );

    expect(await readLink(database)).toMatchObject({
      slack_channel_id: "C-link",
      publish_channel_id: "C-pub",
      approved_audience: JSON.stringify({
        monitored: privateAudience(),
        publish: publicAudience("C-pub"),
      }),
      updated_at: NOW,
    });
  });

  test("a resume makes the link active for no reason, with the audience its card showed approved", async () => {
    const database = await linked({ status: "suspended", status_reason: "channel_made_public" });
    const facts = world();
    facts.channels["C-link"] = channelFacts({ kind: "public" });
    const approval = await approve(database, facts, { action: "resume" });

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );

    expect(await readLink(database)).toMatchObject({
      status: "active",
      status_reason: null,
      approved_audience: JSON.stringify({
        monitored: publicAudience("C-link"),
        publish: publicAudience("C-link"),
      }),
      updated_at: NOW,
    });
  });

  test("a new owner is pinned, and every other open card, which asked the one replaced, goes stale", async () => {
    const database = await linked();
    const facts = world();
    const operator: SetupCaller = { role: "operator", channelId: "toybox-link" };
    const approval = await approve(
      database,
      facts,
      { action: "owner", userId: "U-dave" },
      operator,
    );
    await createStoredLink(database, "other");
    const open = { createdAt: CLICKED, expiresAt: CLICKED + APPROVAL_LIFETIME_MS };
    const sameLink = await createStoredApproval(database, { id: "approval-9", number: 9, ...open });
    const otherLink = await createStoredApproval(database, {
      id: "approval-10",
      number: 10,
      toyboxChannelId: "toybox-other",
      linkId: "other",
      card: { channelId: "C-other", ts: "1000.000300" },
      ...open,
    });

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );

    const [installation] = await database.read(
      (sql) => sql`SELECT owner_user_id FROM installation`,
    );
    expect(installation).toEqual({ owner_user_id: "U-dave" });
    for (const other of [sameLink, otherLink]) {
      expect(await readState(database, other)).toEqual({
        state: "stale",
        staleReason: "owner_changed",
      });
      expect(await readCardItems(database, other)).toEqual([
        { phase: "update", state: "queued", channel_id: other.card.channelId },
      ]);
    }
    expect(await readAudit(database)).toEqual([
      {
        actor: "owner",
        action: "apply",
        link_id: "link",
        approval_id: approval.id,
        subject: "owner_user_id=U-dave",
      },
      {
        actor: "bridge",
        action: "stale",
        link_id: "link",
        approval_id: "approval-9",
        subject: "owner_changed",
      },
      {
        actor: "bridge",
        action: "stale",
        link_id: "other",
        approval_id: "approval-10",
        subject: "owner_changed",
      },
    ]);
  });

  test("what changed that the card didn't show leaves the change to apply", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    await database.write(async (transaction) => {
      await transaction`UPDATE links SET request_mode = 'all', publish_channel_id = 'C-link'`;
      await transaction`
        INSERT INTO allowlist (link_id, user_id, label, added_at) VALUES ('link', 'U-dave', NULL, 7)
      `;
    });
    facts.channels["C-link"] = channelFacts({ name: "renamed" });

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );
    expect(await readAllowlist(database)).toEqual([
      { link_id: "link", user_id: "U-carol", label: null, added_at: NOW },
      { link_id: "link", user_id: "U-dave", label: null, added_at: 7 },
    ]);
  });

  test("an owner the channel lists under another of their IDs is still in it", async () => {
    const database = await linked();
    await database.write(
      (transaction) => transaction`
        INSERT INTO user_aliases (alias_id, user_id) VALUES ('W-owner', 'U-owner')
      `,
    );
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    facts.members["C-link"] = ["W-owner", "U-dave"];

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      applied(approval),
    );
  });
});

describe("an approved change that can't apply", () => {
  test.each([
    [
      "the owner changed",
      "owner_changed",
      (database: BridgeDatabase) => setOwner(database, "U-erin"),
    ],
    [
      "the link was paused",
      "link_changed",
      (database: BridgeDatabase) =>
        database.write((transaction) => transaction`UPDATE links SET status = 'paused'`),
    ],
    [
      "the channel was made public",
      "audience_changed",
      (_: BridgeDatabase, facts: FactsWorld) => {
        facts.channels["C-link"] = channelFacts({ kind: "public" });
      },
    ],
    [
      "someone else allowed U-carol first",
      "setting_changed",
      (database: BridgeDatabase) =>
        database.write(
          (transaction) => transaction`
            INSERT INTO allowlist (link_id, user_id, label, added_at)
            VALUES ('link', 'U-carol', 'ops', 7)
          `,
        ),
    ],
  ] as const)(
    "when %s since the card was posted, it goes stale as %s, and nothing goes in",
    async (_, reason, change) => {
      const database = await linked();
      const facts = world();
      const approval = await approve(database, facts, allowCarol);
      await change(database, facts);
      const before = await readAllowlist(database);

      expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
        staled(approval, reason),
      );

      expect(await readAllowlist(database)).toEqual(before);
      expect(await readState(database, approval)).toEqual({ state: "stale", staleReason: reason });
      expect((await readCardItems(database, approval)).at(-1)).toEqual({
        phase: "update",
        state: "queued",
        channel_id: "C-link",
      });
      expect(await readAudit(database)).toEqual([
        {
          actor: "bridge",
          action: "stale",
          link_id: "link",
          approval_id: approval.id,
          subject: reason,
        },
      ]);
    },
  );

  test.each([
    ["the bot was removed from the channel", "bot_not_member", { isMember: false }],
    ["the channel was archived", "channel_archived", { isArchived: true }],
    ["the owner left the channel", "owner_not_member", { members: [] }],
    ["the lead moved off Copilot", "provider", { provider: "claude" }],
    ["the requests routine was deleted", "routine_missing", { routines: [] }],
    ["Toy Box deleted the channel", "toybox_channel_deleted", { toyBox: null }],
    ["U-carol was deactivated", "deactivated", { carol: { deleted: true } }],
    ["U-carol became a guest", "guest", { carol: { isRestricted: true } }],
  ] as const)(
    "when %s, it goes stale as %s, because it's no longer valid",
    async (_, reason, change) => {
      const database = await linked();
      const facts = world();
      const approval = await approve(database, facts, allowCarol);
      if ("isMember" in change || "isArchived" in change) {
        facts.channels["C-link"] = channelFacts(change);
      }
      if ("members" in change) facts.members["C-link"] = change.members;
      if ("provider" in change) facts.toyBox = toyBoxView({ provider: change.provider });
      if ("routines" in change) facts.toyBox = toyBoxView({ routines: [...change.routines] });
      if ("toyBox" in change) facts.toyBox = change.toyBox;
      if ("carol" in change) facts.people["U-carol"] = slackPerson(change.carol);

      expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
        staled(approval, reason),
      );
      expect(await readAllowlist(database)).toEqual([]);
    },
  );

  test("a link of a Slack channel another link has watched since the card was posted goes stale", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    const facts = world();
    const approval = await approve(database, facts, linkNew, newChannel);
    await createStoredLink(database, "other", { slack_channel_id: "C-new" });

    expect(await attempt(database, fakeFactsReader(facts).reader, approval)).toEqual(
      staled(approval, "already_linked"),
    );
    expect(await readLink(database, "toybox-new")).toBeUndefined();
  });

  test("a change to a link that's gone goes stale without anything read, since nothing could save it", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    await database.write((transaction) => transaction`DELETE FROM links`);
    const { reader, reads } = fakeFactsReader(facts);

    expect(await attempt(database, reader, approval)).toEqual(staled(approval, "link_changed"));
    expect(reads).toEqual([]);
  });

  test("15 minutes after the click, it goes stale as not verified without anything read", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const { reader, reads } = fakeFactsReader(facts);
    const deadline = CLICKED + APPLY_VERIFY_MS;

    expect(await attempt(database, reader, approval, deadline)).toEqual(
      staled(approval, "not_verified"),
    );
    expect(reads).toEqual([]);
    expect(await readAllowlist(database)).toEqual([]);
  });

  test("a moment before 15 minutes are up, it still applies", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const at = CLICKED + APPLY_VERIFY_MS - 1;

    expect(await attempt(database, fakeFactsReader(facts).reader, approval, at)).toEqual(
      applied(approval, at),
    );
  });
});

describe("an approved change that waits", () => {
  test("while Slack isn't connected, it waits without a read until its 15 minutes are up", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    await database.write(
      (transaction) => transaction`UPDATE installation SET status = 'auth_failed'`,
    );
    const { reader, reads } = fakeFactsReader(facts);

    expect(await attempt(database, reader, approval)).toEqual({ kind: "waiting" });
    expect(reads).toEqual([]);
    expect(await readState(database, approval)).toEqual({ state: "approved", staleReason: null });

    expect(await attempt(database, reader, approval, CLICKED + APPLY_VERIFY_MS)).toEqual(
      staled(approval, "not_verified"),
    );
  });

  test("when Toy Box or Slack can't be read, nothing is settled and it stays approved", async () => {
    const toyBoxDown: Unverified = { kind: "unverified", detail: "Toy Box", retryAt: null };
    const slackDown: Unverified = { kind: "unverified", detail: "Slack", retryAt: NOW + 30_000 };
    for (const [down, read] of [
      [{ toyBox: toyBoxDown }, ["toybox toybox-link"]],
      [{ slack: slackDown }, ["toybox toybox-link", "slack C-link C-link U-owner [U-carol]"]],
    ] as const) {
      const database = await linked();
      const approval = await approve(database, world(), allowCarol);
      const { reader, reads } = fakeFactsReader(world(down));

      expect(await attempt(database, reader, approval)).toEqual(
        "toyBox" in down ? toyBoxDown : slackDown,
      );
      expect(reads).toEqual([...read]);
      expect(await readState(database, approval)).toEqual({ state: "approved", staleReason: null });
      expect(await readAllowlist(database)).toEqual([]);
    }
  });

  test("a read still going when the 15 minutes are up proves nothing, however long reads may take", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const { reader } = fakeFactsReader(
      facts,
      (_, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)),
    );

    expect(await attempt(database, reader, approval, CLICKED + APPLY_VERIFY_MS - 20)).toMatchObject(
      {
        kind: "unverified",
      },
    );
    expect(await readState(database, approval)).toEqual({ state: "approved", staleReason: null });
  });

  test("a read still going when the applier stops proves nothing", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const stopping = new AbortController();
    const { reader } = fakeFactsReader(facts, async () => stopping.abort());

    expect(await attempt(database, reader, approval, NOW, stopping.signal)).toMatchObject({
      kind: "unverified",
    });
    expect(await readState(database, approval)).toEqual({ state: "approved", staleReason: null });
  });

  test("when what it needs moves during the read, it's read again for what it needs now", async () => {
    const database = await linked({
      publish_channel_id: "C-pub",
      approved_audience: { monitored: privateAudience(), publish: privateAudience("C-pub") },
    });
    const facts = world();
    facts.channels["C-pub"] = channelFacts({ id: "C-pub", name: "announce" });
    facts.members["C-pub"] = ["U-owner"];
    const approval = await approve(database, facts, allowCarol);
    const { reader, reads } = fakeFactsReader(facts, async (read) => {
      if (read === 1) {
        await database.write(
          (transaction) => transaction`UPDATE links SET publish_channel_id = 'C-link'`,
        );
      }
    });

    expect(await attempt(database, reader, approval)).toEqual(staled(approval, "audience_changed"));
    expect(reads).toEqual([
      "toybox toybox-link",
      "slack C-link C-pub U-owner [U-carol]",
      "toybox toybox-link",
      "slack C-link C-link U-owner [U-carol]",
    ]);
  });

  test("when what it needs keeps moving, it stays unverified rather than judged on facts read for others", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const owners = ["U-erin", "U-owner"];
    const { reader, reads } = fakeFactsReader(facts, (read) =>
      setOwner(database, owners[(read - 1) % 2]!),
    );

    expect(await attempt(database, reader, approval)).toEqual({
      kind: "unverified",
      detail: "what it needs kept changing",
      retryAt: null,
    });
    expect(reads.filter((read) => read.startsWith("slack"))).toEqual([
      "slack C-link C-link U-owner [U-carol]",
      "slack C-link C-link U-erin [U-carol]",
    ]);
    expect(await readState(database, approval)).toEqual({ state: "approved", staleReason: null });
  });
});

describe("an approval that isn't approved", () => {
  test("a pending card is left for the owner, with nothing read", async () => {
    const database = await linked();
    const facts = world();
    const proposal = await propose(database, facts, allowCarol);
    const { reader, reads } = fakeFactsReader(facts);

    expect(await attempt(database, reader, proposal)).toEqual({ kind: "settled", approval: null });
    expect(reads).toEqual([]);
    expect(await readState(database, proposal)).toEqual({ state: "pending", staleReason: null });
  });

  test("one a narrowing voided while its facts were read stays as the narrowing left it", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const { reader } = fakeFactsReader(facts, () =>
      database.write((transaction) => staleApprovals(transaction, [approval], "reversed", NOW)),
    );

    expect(await attempt(database, reader, approval)).toEqual({ kind: "settled", approval: null });
    expect(await readState(database, approval)).toEqual({
      state: "stale",
      staleReason: "reversed",
    });
    expect(await readAllowlist(database)).toEqual([]);
  });

  test("one that applied already isn't applied again", async () => {
    const database = await linked();
    const facts = world();
    const approval = await approve(database, facts, allowCarol);
    const { reader, reads } = fakeFactsReader(facts);
    await attempt(database, reader, approval);
    reads.length = 0;

    expect(await attempt(database, reader, approval, NOW + 1)).toEqual({
      kind: "settled",
      approval: null,
    });
    expect(reads).toEqual([]);
    expect(await readAudit(database)).toHaveLength(1);
  });
});

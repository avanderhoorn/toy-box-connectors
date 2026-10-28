import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import {
  allowlistField,
  APPROVAL_LIFETIME_MS,
  OWNER_PRESENCE_MS,
  type Approval,
} from "@links/model/approvals";
import type { SetupRequest } from "@links/model/setup";
import { privateAudience } from "@links/model/testFixtures";
import type { ChannelFacts } from "@slackapi/model/channels";
import { channelFacts, slackPerson } from "@slackapi/model/testFixtures";
import type { SlackPerson } from "@slackapi/model/users";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { readSlackPersonName, writeSlackPerson } from "@slackapi/server/users";
import { UNREAD_TOYBOX_STREAM, type ToyBoxChannelView } from "@toybox/model/stream";
import { writeToyBoxStream } from "@toybox/server/database";
import { readApproval } from "./approvals";
import type { FactsReader, Unverified } from "./facts";
import { changeSetup, readSetupState, type SetupCaller, type SetupOutcome } from "./setup";
import { createStoredApproval, createStoredLink } from "./testFixtures";

const HOUR_MS = 60 * 60_000;
const NOW = 50 * HOUR_MS;

/** What Slack and Toy Box say. A test changes it to change what the next read finds. */
type World = {
  toyBox: ToyBoxChannelView | null | Unverified;
  /** Set when Slack can't be read. */
  slack: Unverified | null;
  channels: Record<string, ChannelFacts>;
  members: Record<string, readonly string[]>;
  people: Record<string, SlackPerson>;
};

function requestsRoutine(id: string) {
  return {
    id,
    title: "Slack requests",
    schedule: "*/5 * * * *",
    prompt: "Run toy-box-slack inbox.",
  };
}

/**
 * A Copilot lead's channel whose owner posted a minute ago, with the routines createStoredLink's
 * link and a link of C-new run. `changes` replace its parts.
 */
function toyBoxView(changes: Partial<ToyBoxChannelView> = {}): ToyBoxChannelView {
  return {
    provider: "copilot",
    ownerSpokeAt: NOW - 60_000,
    routines: [requestsRoutine("routine-link"), requestsRoutine("routine-new")],
    ...changes,
  };
}

/**
 * The Toy Box channel as toyBoxView shows it, and the private channels C-link and C-new
 * (#release-eng) with the owner and the bot in them. U-carol is a full member of T-home.
 * `changes` replace its parts.
 */
function world(changes: Partial<World> = {}): World {
  return {
    toyBox: toyBoxView(),
    slack: null,
    channels: {
      "C-link": channelFacts(),
      "C-new": channelFacts({ id: "C-new", name: "release-eng" }),
    },
    members: { "C-link": ["U-owner"], "C-new": ["U-owner"] },
    people: { "U-carol": slackPerson() },
    ...changes,
  };
}

/**
 * A reader that answers from `world` as it is when asked, and lists what it was asked.
 * `whileSlackReads` runs while Slack is asked, as anything else that writes to the bridge could.
 */
function fakeReader(world: World, whileSlackReads?: (read: number) => Promise<unknown>) {
  const reads: string[] = [];
  let slackReads = 0;
  const reader: FactsReader = {
    async readToyBox(toyboxChannelId) {
      reads.push(`toybox ${toyboxChannelId}`);
      const { toyBox } = world;
      return toyBox && "kind" in toyBox ? toyBox : { kind: "read", facts: toyBox };
    },
    async readSlack(needed, ownerIds) {
      const { monitored, publish, owner, people } = needed;
      reads.push(`slack ${monitored} ${publish} ${owner} [${people.join(" ")}]`);
      await whileSlackReads?.(++slackReads);
      if (world.slack) return world.slack;
      const ownerIn = (channelId: string) =>
        ownerIds.some((id) => world.members[channelId]?.includes(id));
      return {
        kind: "read",
        facts: {
          monitored: world.channels[monitored] ?? null,
          publish: world.channels[publish] ?? null,
          ownerInMonitored: ownerIn(monitored),
          ownerInPublish: ownerIn(publish),
          people: people.map((userId) => ({ userId, person: world.people[userId] ?? null })),
        },
      };
    },
  };
  return { reader, reads };
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

function change(
  database: BridgeDatabase,
  reader: FactsReader,
  request: SetupRequest,
  caller = lead,
) {
  return changeSetup(database, reader, caller, request, NOW);
}

function proposal(outcome: SetupOutcome): Approval {
  if (outcome.kind !== "proposed") throw new Error(`Setup was ${outcome.kind}, not a proposal.`);
  return outcome.approval;
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

function setOwnerSpokeAt(database: BridgeDatabase, channelId: string, ownerSpokeAt: number) {
  const stream = { ...UNREAD_TOYBOX_STREAM, ownerSpokeAt };
  return database.write((transaction) => writeToyBoxStream(transaction, channelId, stream));
}

async function readApprovals(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) =>
        sql`SELECT id, toybox_channel_id, state, stale_reason FROM approvals ORDER BY number`,
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

async function readAudit(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`SELECT actor, action, link_id, approval_id, subject FROM audit ORDER BY id`,
    )),
  ];
}

async function readCounts(database: BridgeDatabase) {
  const [counts] = await database.read(
    (sql) => sql`
      SELECT (SELECT COUNT(*) FROM links) AS links, (SELECT COUNT(*) FROM allowlist) AS allowlist,
        (SELECT COUNT(*) FROM approvals) AS approvals, (SELECT COUNT(*) FROM outbox) AS outbox
    `,
  );
  return counts;
}

describe("proposing a setup change", () => {
  test("a link only stores a proposal, with its card queued in the channel it would watch", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    const { reader, reads } = fakeReader(world());

    const outcome = await change(database, reader, linkNew, newChannel);

    const approval = proposal(outcome);
    expect(outcome).toEqual({
      kind: "proposed",
      approval,
      existing: false,
      channelName: "release-eng",
    });
    expect(approval).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      number: 1,
      toyboxChannelId: "toybox-new",
      linkId: null,
      action: "link",
      patch: [
        { field: "slack_channel_id", after: "C-new" },
        { field: "publish_channel_id", after: "C-new" },
        { field: "request_mode", after: "mention" },
        { field: "observe", after: "requesters" },
        { field: "requests_routine_id", after: "routine-new" },
        { field: "allowlist.U-carol", after: { label: null } },
      ],
      readSet: {
        ownerUserId: "U-owner",
        link: "none",
        monitored: privateAudience("C-new"),
        publish: privateAudience("C-new"),
        before: {
          slack_channel_id: null,
          publish_channel_id: null,
          request_mode: null,
          observe: null,
          requests_routine_id: null,
          "allowlist.U-carol": null,
        },
      },
      card: { channelId: "C-new", ts: null },
      state: "pending",
      staleReason: null,
      appliedAt: null,
      decidedBy: null,
      decidedAt: null,
      reportedAt: null,
      createdBy: "lead",
      createdAt: NOW,
      expiresAt: NOW + APPROVAL_LIFETIME_MS,
    });
    expect(await database.read((sql) => readApproval(sql, approval.id))).toEqual(approval);
    expect(await readCounts(database)).toEqual({ links: 0, allowlist: 0, approvals: 1, outbox: 1 });
    expect(await readOutbox(database)).toEqual([
      { kind: "card", phase: "post", approval_id: approval.id, link_id: null, channel_id: "C-new" },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "lead",
        action: "propose",
        link_id: null,
        approval_id: approval.id,
        subject: "link",
      },
    ]);
    // The card names Carol as Slack described her for this proposal.
    expect(await database.read((sql) => readSlackPersonName(sql, "U-carol"))).toBe("Carol Chen");
    expect(reads).toEqual(["toybox toybox-new", "slack C-new C-new U-owner [U-carol]"]);
  });

  test("allowing someone is checked against the link as it stands, and the operator's proposal is theirs", async () => {
    const database = await linked();
    const { reader, reads } = fakeReader(world());
    const operator: SetupCaller = { role: "operator", channelId: "toybox-link" };

    const approval = proposal(await change(database, reader, allowCarol, operator));

    expect(approval).toMatchObject({
      linkId: "link",
      action: "allow",
      patch: [{ field: "allowlist.U-carol", after: { label: null } }],
      readSet: {
        ownerUserId: "U-owner",
        link: { id: "link", status: "active", statusReason: null },
        monitored: privateAudience(),
        publish: privateAudience(),
        before: { "allowlist.U-carol": null },
      },
      card: { channelId: "C-link", ts: null },
      createdBy: "operator",
    });
    expect(await readCounts(database)).toMatchObject({ allowlist: 0, approvals: 1 });
    expect(await readAudit(database)).toEqual([
      {
        actor: "operator",
        action: "propose",
        link_id: "link",
        approval_id: approval.id,
        subject: "allow",
      },
    ]);
    expect(reads).toEqual(["toybox toybox-link", "slack C-link C-link U-owner [U-carol]"]);
  });

  test("the same change proposed again returns the card that waits, without reading or posting", async () => {
    const database = await linked();
    const { reader, reads } = fakeReader(world());
    const first = proposal(await change(database, reader, allowCarol));

    expect(await change(database, reader, allowCarol)).toEqual({
      kind: "proposed",
      approval: first,
      existing: true,
      channelName: null,
    });
    expect(reads).toHaveLength(2);
    expect(await readCounts(database)).toMatchObject({ approvals: 1, outbox: 1 });
  });

  test("a card whose hour is up expires rather than stand in for the same change", async () => {
    const database = await linked();
    await createStoredApproval(database, {
      createdAt: NOW - APPROVAL_LIFETIME_MS,
      expiresAt: NOW,
    });
    const { reader } = fakeReader(world());

    const outcome = await change(database, reader, allowCarol);

    const approval = proposal(outcome);
    expect(outcome).toMatchObject({ existing: false });
    expect(await readApprovals(database)).toEqual([
      { id: "approval-1", toybox_channel_id: "toybox-link", state: "expired", stale_reason: null },
      { id: approval.id, toybox_channel_id: "toybox-link", state: "pending", stale_reason: null },
    ]);
    expect(await readOutbox(database)).toMatchObject([
      { kind: "card", phase: "update", approval_id: "approval-1" },
      { kind: "card", phase: "post", approval_id: approval.id },
    ]);
    expect(await readAudit(database)).toMatchObject([
      { actor: "bridge", action: "expire", approval_id: "approval-1", subject: null },
      { actor: "lead", action: "propose", approval_id: approval.id },
    ]);
  });

  test("while the owner is away, widening is refused before Slack is asked", async () => {
    for (const ownerSpokeAt of [null, NOW - OWNER_PRESENCE_MS - 1]) {
      const database = await linked();
      const { reader, reads } = fakeReader(world({ toyBox: toyBoxView({ ownerSpokeAt }) }));

      expect(await change(database, reader, allowCarol)).toEqual({
        kind: "refused",
        reason: "owner_away",
      });
      expect(reads).toEqual(["toybox toybox-link"]);
      expect(await readCounts(database)).toMatchObject({ approvals: 0, outbox: 0 });
    }
  });

  test("the owner's latest post counts, whether the snapshot or the followed stream saw it", async () => {
    const recently = NOW - 60_000;
    const longAgo = NOW - 2 * HOUR_MS;
    const cases = [
      { snapshot: null, stream: recently },
      { snapshot: recently, stream: longAgo },
      { snapshot: longAgo, stream: recently },
    ];
    for (const { snapshot, stream } of cases) {
      const database = await linked();
      await setOwnerSpokeAt(database, "toybox-link", stream);
      const { reader } = fakeReader(world({ toyBox: toyBoxView({ ownerSpokeAt: snapshot }) }));

      expect(await change(database, reader, allowCarol)).toMatchObject({ kind: "proposed" });
    }
  });

  test("a Toy Box channel may have three cards pending, whatever other channels have", async () => {
    const database = await linked();
    for (const number of [1, 2, 3]) await storeCard(database, number);
    const { reader, reads } = fakeReader(world());

    expect(await change(database, reader, allowCarol)).toEqual({
      kind: "refused",
      reason: "too_many_pending",
    });
    expect(reads).toEqual([]);
    expect(await change(database, reader, linkNew, newChannel)).toMatchObject({ kind: "proposed" });
  });

  test("a Toy Box channel may propose ten changes an hour, whatever became of them", async () => {
    const decided = { state: "rejected", decidedBy: "U-owner", decidedAt: NOW } as const;
    for (const createdAt of [NOW - HOUR_MS + 1, NOW - HOUR_MS]) {
      const database = await linked();
      for (let number = 1; number <= 10; number++) {
        await storeCard(database, number, { ...decided, createdAt });
      }
      const { reader, reads } = fakeReader(world());

      const outcome = await change(database, reader, allowCarol);

      if (createdAt > NOW - HOUR_MS) {
        expect(outcome).toEqual({ kind: "refused", reason: "too_many_created" });
        expect(reads).toEqual([]);
        expect(await change(database, reader, linkNew, newChannel)).toMatchObject({
          kind: "proposed",
        });
      } else {
        expect(outcome).toMatchObject({ kind: "proposed" });
      }
    }
  });

  test("one card allows at most twenty people, and more are refused before anything is read", async () => {
    const database = await linked();
    const userIds = Array.from({ length: 21 }, (_, index) => `U-${index}`);
    const { reader, reads } = fakeReader(world());

    expect(await change(database, reader, { action: "allow", userIds })).toEqual({
      kind: "refused",
      reason: "too_many_people",
    });
    expect(reads).toEqual([]);
  });

  test("no second card may link a Slack channel another Toy Box channel's card links", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await storeCard(database, 1, {
      toyboxChannelId: "toybox-other",
      linkId: null,
      action: "link",
      patch: [{ field: "slack_channel_id", after: "C-new" }],
    });
    const { reader, reads } = fakeReader(world());

    expect(await change(database, reader, linkNew, newChannel)).toEqual({
      kind: "refused",
      reason: "overlap",
    });
    expect(reads).toEqual([]);
    expect(await readCounts(database)).toMatchObject({ approvals: 1, outbox: 0 });
  });

  test("a Slack channel another link watches can't be linked", async () => {
    const database = await linked();
    await createStoredLink(database, "other", { slack_channel_id: "C-new" });
    const { reader } = fakeReader(world());

    expect(await change(database, reader, linkNew, newChannel)).toEqual({
      kind: "refused",
      reason: "already_linked",
    });
    expect(await readCounts(database)).toMatchObject({ approvals: 0, outbox: 0 });
  });

  test("a lead that doesn't run on Copilot can't propose", async () => {
    const database = await linked();
    const { reader } = fakeReader(world({ toyBox: toyBoxView({ provider: "claude" }) }));

    expect(await change(database, reader, allowCarol)).toEqual({
      kind: "refused",
      reason: "provider",
    });
    expect(await readCounts(database)).toMatchObject({ approvals: 0, outbox: 0 });
  });

  test("someone the admission check refuses can't be proposed, so the card never shows them", async () => {
    const people = [
      { carol: slackPerson({ isRestricted: true }), reason: "guest" },
      { carol: slackPerson({ deleted: true }), reason: "deactivated" },
      { carol: slackPerson({ teamId: "T-other" }), reason: "other_workspace" },
      { carol: undefined, reason: "user_not_found" },
    ] as const;
    for (const { carol, reason } of people) {
      const database = await linked();
      const { reader } = fakeReader(world({ people: carol ? { "U-carol": carol } : {} }));

      expect(await change(database, reader, allowCarol)).toEqual({ kind: "refused", reason });
      expect(await readCounts(database)).toMatchObject({ approvals: 0, outbox: 0 });
      expect(await database.read((sql) => readSlackPersonName(sql, "U-carol"))).toBeNull();
    }
  });

  test("the owner counts in a channel under any ID the bridge knows them by", async () => {
    const database = await linked();
    const { reader } = fakeReader(world({ members: { "C-link": ["W-owner"] } }));

    expect(await change(database, reader, allowCarol)).toEqual({
      kind: "refused",
      reason: "owner_not_member",
    });

    const owner = slackPerson({
      id: "U-owner",
      enterpriseId: "E-org",
      enterpriseUserId: "W-owner",
    });
    await database.write((transaction) => writeSlackPerson(transaction, owner, NOW));

    expect(await change(database, reader, allowCarol)).toMatchObject({ kind: "proposed" });
  });

  test("when Slack or Toy Box can't be read, the change is unverified and nothing is stored", async () => {
    const toyBoxDown: Unverified = { kind: "unverified", detail: "Toy Box", retryAt: null };
    const slackDown: Unverified = { kind: "unverified", detail: "Slack", retryAt: NOW + 30_000 };
    for (const [down, read] of [
      [{ toyBox: toyBoxDown }, ["toybox toybox-link"]],
      [{ slack: slackDown }, ["toybox toybox-link", "slack C-link C-link U-owner [U-carol]"]],
    ] as const) {
      const database = await linked();
      const { reader, reads } = fakeReader(world(down));

      expect(await change(database, reader, allowCarol)).toEqual(
        "toyBox" in down ? toyBoxDown : slackDown,
      );
      expect(reads).toEqual([...read]);
      expect(await readCounts(database)).toMatchObject({ approvals: 0, outbox: 0 });
    }
  });

  test("a Toy Box channel that's gone is refused before Slack is asked", async () => {
    const database = await linked();
    const { reader, reads } = fakeReader(world({ toyBox: null }));

    expect(await change(database, reader, allowCarol)).toEqual({
      kind: "refused",
      reason: "toybox_channel_deleted",
    });
    expect(reads).toEqual(["toybox toybox-link"]);
  });

  test("when what a change needs moves during the read, it's read again for what it needs now", async () => {
    const database = await linked({
      publish_channel_id: "C-pub",
      approved_audience: { monitored: privateAudience(), publish: privateAudience("C-pub") },
    });
    const facts = world();
    facts.channels["C-pub"] = channelFacts({ id: "C-pub", name: "announce" });
    facts.members["C-pub"] = ["U-owner"];
    const back: SetupRequest = { action: "set", change: { publishChannelId: "C-link" } };
    const { reader, reads } = fakeReader(facts, async (read) => {
      if (read === 1) await change(database, fakeReader(facts).reader, back);
    });

    const approval = proposal(await change(database, reader, allowCarol));

    expect(approval.readSet).toMatchObject({
      monitored: privateAudience(),
      publish: privateAudience(),
    });
    expect(reads).toEqual([
      "toybox toybox-link",
      "slack C-link C-pub U-owner [U-carol]",
      "toybox toybox-link",
      "slack C-link C-link U-owner [U-carol]",
    ]);
  });

  test("a change whose needs keep moving is refused rather than judged on facts read for others", async () => {
    const database = await linked();
    const owners = ["U-erin", "U-owner"];
    const { reader, reads } = fakeReader(world(), (read) =>
      database.write(
        (transaction) =>
          transaction`UPDATE installation SET owner_user_id = ${owners[(read - 1) % 2]!}`,
      ),
    );

    expect(await change(database, reader, allowCarol)).toEqual({
      kind: "refused",
      reason: "changed",
    });
    expect(reads.filter((read) => read.startsWith("slack"))).toEqual([
      "slack C-link C-link U-owner [U-carol]",
      "slack C-link C-link U-erin [U-carol]",
    ]);
    expect(await readCounts(database)).toMatchObject({ approvals: 0, outbox: 0 });
  });

  test("the same change proposed while this one was read returns that card", async () => {
    const database = await linked();
    const { reader } = fakeReader(world(), () =>
      createStoredApproval(database, { createdAt: NOW, expiresAt: NOW + APPROVAL_LIFETIME_MS }),
    );

    expect(await change(database, reader, allowCarol)).toMatchObject({
      kind: "proposed",
      approval: { id: "approval-1" },
      existing: true,
      channelName: null,
    });
    expect(await readCounts(database)).toMatchObject({ approvals: 1, outbox: 0 });
  });

  test("a set that only narrows applies at once without reading, and voids the cards it reverses", async () => {
    const database = await linked({
      request_mode: "all",
      observe: "channel",
      publish_channel_id: "C-pub",
      approved_audience: { monitored: privateAudience(), publish: privateAudience("C-pub") },
    });
    const movePublish = await storeCard(database, 1, {
      action: "set",
      patch: [{ field: "publish_channel_id", after: "C-other" }],
    });
    await storeCard(database, 2);
    const { reader, reads } = fakeReader(world());
    const narrow: SetupRequest = {
      action: "set",
      change: { requestMode: "mention", publishChannelId: "C-link" },
    };

    expect(await change(database, reader, narrow)).toEqual({
      kind: "narrowed",
      patch: [
        { field: "request_mode", after: "mention" },
        { field: "publish_channel_id", after: "C-link" },
      ],
      voided: [{ ...movePublish, state: "stale", staleReason: "reversed" }],
    });

    const [link] = await database.read(
      (sql) =>
        sql`SELECT request_mode, observe, publish_channel_id, approved_audience, updated_at FROM links`,
    );
    expect({ ...link, approved_audience: JSON.parse(link.approved_audience) }).toEqual({
      request_mode: "mention",
      observe: "channel",
      publish_channel_id: "C-link",
      // Posts go back where the owner approved the audience when the link was made.
      approved_audience: { monitored: privateAudience(), publish: privateAudience() },
      updated_at: NOW,
    });
    expect(await readApprovals(database)).toMatchObject([
      { id: "approval-1", state: "stale", stale_reason: "reversed" },
      { id: "approval-2", state: "pending" },
    ]);
    expect(await readOutbox(database)).toEqual([
      {
        kind: "card",
        phase: "update",
        approval_id: "approval-1",
        link_id: "link",
        channel_id: "C-link",
      },
    ]);
    expect(await readAudit(database)).toEqual([
      {
        actor: "lead",
        action: "set",
        link_id: "link",
        approval_id: null,
        subject: "request_mode=mention",
      },
      {
        actor: "lead",
        action: "set",
        link_id: "link",
        approval_id: null,
        subject: "publish_channel_id=C-link",
      },
      {
        actor: "bridge",
        action: "stale",
        link_id: "link",
        approval_id: "approval-1",
        subject: "reversed",
      },
    ]);
    expect(reads).toEqual([]);
  });

  test("a change that changes nothing stores and reads nothing", async () => {
    const database = await linked();
    const { reader, reads } = fakeReader(world());

    expect(await change(database, reader, { action: "allow", userIds: ["U-owner"] })).toEqual({
      kind: "unchanged",
    });
    expect(reads).toEqual([]);
    expect(await readCounts(database)).toEqual({ links: 1, allowlist: 0, approvals: 0, outbox: 0 });
    expect(await readAudit(database)).toEqual([]);
  });

  test("before the bridge is installed, nothing can be set up", async () => {
    const database = await openTestDatabase();
    const { reader, reads } = fakeReader(world());

    expect(await change(database, reader, linkNew, newChannel)).toEqual({
      kind: "refused",
      reason: "not_connected",
    });
    expect(reads).toEqual([]);
  });
});

describe("reading setup state", () => {
  test("reads the installation, and the Toy Box channel's link with everyone it allows", async () => {
    const database = await linked({
      publish_channel_id: "C-pub",
      request_mode: "all",
      observe: "channel",
      status: "suspended",
      status_reason: "audience",
      approved_audience: { monitored: privateAudience(), publish: privateAudience("C-pub") },
    });
    await database.write(
      (transaction) => transaction`
        INSERT INTO allowlist (link_id, user_id, label, added_at)
        VALUES ('link', 'U-dave', 'design', 1), ('link', 'U-carol', NULL, 2)
      `,
    );

    expect(await database.read((sql) => readSetupState(sql, "toybox-link"))).toEqual({
      installation: {
        teamId: "T-home",
        enterpriseId: null,
        ownerUserId: "U-owner",
        status: "active",
      },
      toyboxChannelId: "toybox-link",
      link: {
        id: "link",
        slackChannelId: "C-link",
        publishChannelId: "C-pub",
        requestMode: "all",
        observe: "channel",
        status: "suspended",
        statusReason: "audience",
        requestsRoutineId: "routine-link",
        approved: { monitored: privateAudience(), publish: privateAudience("C-pub") },
        allowlist: new Map([
          ["U-carol", { label: null }],
          ["U-dave", { label: "design" }],
        ]),
      },
    });
    expect(await database.read((sql) => readSetupState(sql, "toybox-new"))).toMatchObject({
      toyboxChannelId: "toybox-new",
      link: null,
    });
  });

  test("there's nothing to read before the bridge is installed", async () => {
    const database = await openTestDatabase();

    expect(await database.read((sql) => readSetupState(sql, "toybox-link"))).toBeNull();
  });
});

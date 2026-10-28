import type { BridgeDatabase } from "@bridge/server/database";
import {
  checkProposal,
  ownerPresent,
  type Approval,
  type LinkStatus,
  type ObserveMode,
  type PatchEntry,
  type ProposalCaller,
  type RequestMode,
} from "@links/model/approvals";
import type { ApprovedAudience } from "@links/model/audience";
import {
  draftSetup,
  planProposal,
  type FactsNeeded,
  type FreshFacts,
  type ProposalPlanRefusal,
  type SetupDraft,
  type SetupLink,
  type SetupRefusal,
  type SetupRequest,
  type SetupState,
} from "@links/model/setup";
import { readInstallation } from "@slackapi/server/installation";
import { readPersonIds, writeSlackPerson } from "@slackapi/server/users";
import { readToyBoxStream } from "@toybox/server/database";
import {
  countProposalsSince,
  createApproval,
  expireApprovals,
  readAllOpenApprovals,
} from "./approvals";
import type { FactsReader, Unverified } from "./facts";
import { narrowSettings } from "./narrowing";

// Setup commands.
//
// A setup command is drafted, checked and stored in write transactions, and the facts a proposal
// is checked against are read between them, outside any transaction. A draft meets the limits
// before anything is read, and the owner's presence in Toy Box before Slack is asked, so a lead
// steered to propose again and again mostly costs nothing. The draft made after the read is the
// one that counts, checked against facts read for exactly what it needs. When what it needs keeps
// changing under the reads, the command is refused rather than judged on facts read for
// something else.

/** How long a setup command may spend reading Slack and Toy Box, well inside the CLI's 60 s. */
export const SETUP_READ_MS = 40_000;

/** How many times a setup command reads facts before it gives up on a state that keeps changing. */
const MAX_READS = 2;

const HOUR_MS = 60 * 60_000;

/** Who asked for a setup change, and the Toy Box channel it's for. */
export type SetupCaller = { role: ProposalCaller; channelId: string };

export type SetupOutcome =
  | {
      kind: "refused";
      reason:
        | SetupRefusal
        | ProposalPlanRefusal
        /** What the change needs kept changing while the bridge read it. */
        | "changed";
    }
  /** Slack or Toy Box couldn't be read in time, so nothing was proposed. */
  | Unverified
  /** Nothing would change. */
  | { kind: "unchanged" }
  /** A set that only narrows applied at once, voiding the cards it reverses. */
  | { kind: "narrowed"; patch: readonly PatchEntry[]; voided: readonly Approval[] }
  /**
   * The owner has a card to decide: a new one, or the same change waiting already. `channelName`
   * is the card channel's name as Slack gave it just now, which only a new proposal read.
   */
  | { kind: "proposed"; approval: Approval; existing: boolean; channelName: string | null };

type SetupLinkRow = {
  id: string;
  slack_channel_id: string;
  publish_channel_id: string;
  request_mode: RequestMode;
  observe: ObserveMode;
  status: LinkStatus;
  status_reason: string | null;
  requests_routine_id: string;
  approved_audience: string;
};

/**
 * What setup for `toyboxChannelId` is decided against, or null before the bridge is installed.
 * `slackUsable` says whether the bridge can use Slack now, which isn't stored.
 */
export async function readSetupState(
  sql: Bun.SQL,
  toyboxChannelId: string,
  slackUsable: boolean,
): Promise<SetupState | null> {
  const installation = await readInstallation(sql);
  if (!installation) return null;
  const [row] = await sql<SetupLinkRow[]>`
    SELECT id, slack_channel_id, publish_channel_id, request_mode, observe, status, status_reason,
      requests_routine_id, approved_audience
    FROM links WHERE toybox_channel_id = ${toyboxChannelId}
  `;
  const { teamId, enterpriseId, ownerUserId, status } = installation;
  return {
    installation: { teamId, enterpriseId, ownerUserId, status },
    slackUsable,
    toyboxChannelId,
    link: row ? await readSetupLink(sql, row) : null,
  };
}

/**
 * Runs a setup command for `caller`'s Toy Box channel as of `at`. A refusal, or a change that
 * changes nothing, returns at once, and a set that only narrows applies at once, even when
 * `slackUsable` says the bridge can't use Slack now, which refuses anything else. A proposal is
 * stored, with its card queued, only once facts read for it show it's valid, and the reads give
 * up when `signal` aborts.
 */
export async function changeSetup(
  database: BridgeDatabase,
  reader: FactsReader,
  caller: SetupCaller,
  request: SetupRequest,
  slackUsable: boolean,
  at: number,
  signal: AbortSignal = AbortSignal.timeout(SETUP_READ_MS),
): Promise<SetupOutcome> {
  let fresh: Fresh | null = null;
  for (let reads = 0; ; reads++) {
    const read: Fresh | null = fresh;
    const step: SetupStep = await database.write((transaction) =>
      takeStep(transaction, caller, request, slackUsable, read, at),
    );
    if (step.kind !== "read") return step;
    if (reads === MAX_READS) return { kind: "refused", reason: "changed" };
    const toyBox = await reader.readToyBox(caller.channelId, signal);
    if (toyBox.kind === "unverified") return toyBox;
    if (!toyBox.facts) return { kind: "refused", reason: "toybox_channel_deleted" };
    // A snapshot carries only recent messages, so the followed stream may know of a later one.
    const ownerSpokeAt = latest(toyBox.facts.ownerSpokeAt, step.ownerSpokeAt);
    if (!ownerPresent(ownerSpokeAt, at)) return { kind: "refused", reason: "owner_away" };
    const slack = await reader.readSlack(step.needed, step.ownerIds, signal);
    if (slack.kind === "unverified") return slack;
    const facts = { ...slack.facts, toyBox: { ...toyBox.facts, ownerSpokeAt } };
    fresh = { needed: step.needed, facts };
  }
}

/** Facts read for what a draft needed. */
type Fresh = { needed: FactsNeeded; facts: FreshFacts };

type SetupStep =
  | SetupOutcome
  /** The draft needs facts read for it. */
  | { kind: "read"; needed: FactsNeeded; ownerIds: string[]; ownerSpokeAt: number | null };

/**
 * Drafts the command against the state as stored, and settles it when it can be: a refusal, a
 * change that changes nothing, a narrowing set, or a proposal the limits refuse or that's waiting
 * already. A proposal checked against facts read for exactly what it needs is planned and, when
 * it's valid, stored. Any other asks for a read. A card whose hour is up expires first, so it
 * neither counts as waiting nor stands in for the same change proposed again.
 */
async function takeStep(
  transaction: Bun.SQL,
  caller: SetupCaller,
  request: SetupRequest,
  slackUsable: boolean,
  fresh: Fresh | null,
  at: number,
): Promise<SetupStep> {
  await expireApprovals(transaction, at);
  const state = await readSetupState(transaction, caller.channelId, slackUsable);
  if (!state) return { kind: "refused", reason: "not_connected" };
  const draft = draftSetup(state, request);
  switch (draft.kind) {
    case "refused":
    case "unchanged":
      return draft;
    case "narrowing": {
      const voided = await narrowSettings(transaction, caller.role, draft.linkId, draft.patch, at);
      return { kind: "narrowed", patch: draft.patch, voided };
    }
    case "proposal":
      return propose(transaction, caller, state, draft, fresh, at);
  }
}

async function propose(
  transaction: Bun.SQL,
  caller: SetupCaller,
  state: SetupState,
  draft: Extract<SetupDraft, { kind: "proposal" }>,
  fresh: Fresh | null,
  at: number,
): Promise<SetupStep> {
  const open = await readAllOpenApprovals(transaction);
  const createdInLastHour = await countProposalsSince(transaction, caller.channelId, at - HOUR_MS);
  if (!fresh || !Bun.deepEquals(fresh.needed, draft.needed, true)) {
    const check = checkProposal(draft.proposal, open, createdInLastHour);
    if (check.kind === "existing") return proposed(check.approval, true, null);
    if (check.kind === "refused") return check;
    const stream = await readToyBoxStream(transaction, caller.channelId);
    return {
      kind: "read",
      needed: draft.needed,
      ownerIds: await readPersonIds(transaction, draft.needed.owner),
      ownerSpokeAt: stream.ownerSpokeAt,
    };
  }
  const elsewhere = await linkedElsewhere(transaction, draft.needed.monitored, caller.channelId);
  const context = { open, createdInLastHour, linkedElsewhere: elsewhere };
  const plan = planProposal(state, draft, fresh.facts, context, at);
  switch (plan.kind) {
    case "existing":
      return proposed(plan.approval, true, null);
    case "refused":
      return plan;
    case "new": {
      // The card names everyone it admits by what the bridge stored about them.
      for (const { person } of fresh.facts.people) {
        if (person) await writeSlackPerson(transaction, person, at);
      }
      const approval = await createApproval(
        transaction,
        {
          ...draft.proposal,
          readSet: plan.readSet,
          cardChannelId: plan.cardChannelId,
          createdBy: caller.role,
        },
        at,
      );
      return proposed(approval, false, fresh.facts.monitored?.name ?? null);
    }
  }
}

/** Whether another Toy Box channel's link watches `slackChannelId`. */
export async function linkedElsewhere(
  sql: Bun.SQL,
  slackChannelId: string,
  toyboxChannelId: string,
): Promise<boolean> {
  const [link] = await sql`
    SELECT id FROM links
    WHERE slack_channel_id = ${slackChannelId} AND toybox_channel_id <> ${toyboxChannelId}
  `;
  return link !== undefined;
}

async function readSetupLink(sql: Bun.SQL, row: SetupLinkRow): Promise<SetupLink> {
  const entries = await sql<{ user_id: string; label: string | null }[]>`
    SELECT user_id, label FROM allowlist WHERE link_id = ${row.id} ORDER BY user_id
  `;
  return {
    id: row.id,
    slackChannelId: row.slack_channel_id,
    publishChannelId: row.publish_channel_id,
    requestMode: row.request_mode,
    observe: row.observe,
    status: row.status,
    statusReason: row.status_reason,
    requestsRoutineId: row.requests_routine_id,
    approved: JSON.parse(row.approved_audience) as ApprovedAudience,
    allowlist: new Map(entries.map((entry) => [entry.user_id, { label: entry.label }])),
  };
}

function proposed(approval: Approval, existing: boolean, channelName: string | null): SetupStep {
  return { kind: "proposed", approval, existing, channelName };
}

function latest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

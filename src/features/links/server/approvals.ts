import {
  APPROVAL_LIFETIME_MS,
  applyApproval,
  approvalStates,
  clickedApprovalId,
  decide,
  expireApproval,
  isOpen,
  staleApproval,
  type Approval,
  type ApprovalAction,
  type ApprovalState,
  type ClickedState,
  type IgnoredClick,
  type PatchEntry,
  type ProposalCaller,
  type ProposalDraft,
  type ReadSet,
  type StaleReason,
} from "@links/model/approvals";
import { queueCard } from "@outbox/server/database";
import { readInteraction } from "@slackapi/model/interactions";
import type { SlackTs } from "@slackapi/model/ts";
import { readInstallation } from "@slackapi/server/installation";
import { canonicalUserId } from "@slackapi/server/users";
import { audit, auditPatch } from "./audit";

// Stored approvals.
//
// A setup command stores a proposal, with its card queued, in the transaction that checks it. The
// receiver hands over every interactive payload in its delivery's transaction, before the ack,
// and a click is decided there from what's stored: the installation, the approval and the aliases
// of people the bridge has read. Nothing here calls Slack, so the decision commits before Slack is
// acked and a redelivered click finds it made. An approved approval applies after the ack, in
// apply.ts, and is recorded here.

type ApprovalRow = {
  id: string;
  number: number;
  toybox_channel_id: string;
  link_id: string | null;
  action: ApprovalAction;
  patch: string;
  read_set: string;
  owner_user_id: string;
  card_channel_id: string;
  card_ts: SlackTs | null;
  state: ApprovalState;
  stale_reason: StaleReason | null;
  applied_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  reported_at: number | null;
  created_by: ProposalCaller;
  created_at: number;
  expires_at: number;
};

/** Why the bridge ignored an interactive payload. */
export type IgnoredInteraction =
  | IgnoredClick
  /** It wasn't a click on a button, such as a shortcut, which the app never offers. */
  | "not_a_click"
  | "malformed";

/** What a click did, which the receiver acts on once Slack is acked. */
export type ClickResult =
  | { kind: "ignored"; reason: IgnoredInteraction }
  /** The owner clicked an approval decided already. */
  | { kind: "unchanged" }
  /** The owner decided the approval, or clicked too late and it expired. */
  | { kind: "settled"; approvalId: string; state: ClickedState };

/** The approval `approvalId` names, or null when there's no such approval. */
export async function readApproval(sql: Bun.SQL, approvalId: string): Promise<Approval | null> {
  const [row] = await sql<ApprovalRow[]>`SELECT * FROM approvals WHERE id = ${approvalId}`;
  return row ? approvalFromRow(row) : null;
}

/** A link's approvals that wait for the owner or for apply, oldest first. */
export async function readOpenApprovals(sql: Bun.SQL, linkId: string): Promise<Approval[]> {
  const rows = await sql<ApprovalRow[]>`
    SELECT * FROM approvals WHERE link_id = ${linkId} AND state IN ${sql(openStates)}
    ORDER BY number
  `;
  return rows.map(approvalFromRow);
}

/** Every approval that waits for the owner or for apply, whichever Toy Box channel made it, oldest first. */
export async function readAllOpenApprovals(sql: Bun.SQL): Promise<Approval[]> {
  const rows = await sql<ApprovalRow[]>`
    SELECT * FROM approvals WHERE state IN ${sql(openStates)} ORDER BY number
  `;
  return rows.map(approvalFromRow);
}

/** How many proposals a Toy Box channel has made since `since`, whatever became of them. */
export async function countProposalsSince(
  sql: Bun.SQL,
  toyboxChannelId: string,
  since: number,
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count FROM approvals
    WHERE toybox_channel_id = ${toyboxChannelId} AND created_at > ${since}
  `;
  return row!.count;
}

/** What a new proposal holds besides what the bridge gives every one. */
export type NewProposal = ProposalDraft & {
  readSet: ReadSet;
  cardChannelId: string;
  createdBy: ProposalCaller;
};

/**
 * Stores a proposal for the owner to decide within the hour, queues posting its card and audits
 * it. It gets 128 random bits as the ID its buttons carry, and a number no approval has had.
 */
export async function createApproval(
  transaction: Bun.SQL,
  proposal: NewProposal,
  now: number,
): Promise<Approval> {
  const pending: Omit<Approval, "number"> = {
    id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    toyboxChannelId: proposal.toyboxChannelId,
    linkId: proposal.linkId,
    action: proposal.action,
    patch: proposal.patch,
    readSet: proposal.readSet,
    card: { channelId: proposal.cardChannelId, ts: null },
    state: "pending",
    staleReason: null,
    appliedAt: null,
    decidedBy: null,
    decidedAt: null,
    reportedAt: null,
    createdBy: proposal.createdBy,
    createdAt: now,
    expiresAt: now + APPROVAL_LIFETIME_MS,
  };
  const [row] = await transaction<{ number: number }[]>`
    INSERT INTO approvals ${transaction(approvalColumns(pending))} RETURNING number
  `;
  const approval: Approval = { ...pending, number: row!.number };
  await queueCard(
    transaction,
    {
      approvalId: approval.id,
      linkId: approval.linkId,
      channelId: approval.card.channelId,
      phase: "post",
    },
    now,
  );
  await audit(
    transaction,
    {
      actor: approval.createdBy,
      action: "propose",
      linkId: approval.linkId,
      approvalId: approval.id,
      subject: approval.action,
    },
    now,
  );
  return approval;
}

/**
 * Expires every pending approval whose hour is up, queues the update that shows it on each card
 * and audits each. Returns them as they're stored now.
 */
export async function expireApprovals(transaction: Bun.SQL, now: number): Promise<Approval[]> {
  const rows = await transaction<ApprovalRow[]>`
    SELECT * FROM approvals WHERE state = 'pending' AND expires_at <= ${now} ORDER BY number
  `;
  const expired: Approval[] = [];
  for (const row of rows) {
    const approval = expireApproval(approvalFromRow(row), now);
    await saveApproval(transaction, approval);
    await queueUpdate(transaction, approval, now);
    await audit(
      transaction,
      { actor: "bridge", action: "expire", linkId: approval.linkId, approvalId: approval.id },
      now,
    );
    expired.push(approval);
  }
  return expired;
}

/**
 * Marks open approvals stale for `reason`, queues the update that shows it on each card and audits
 * each. Returns them as they're stored now.
 */
export async function staleApprovals(
  transaction: Bun.SQL,
  approvals: readonly Approval[],
  reason: StaleReason,
  now: number,
): Promise<Approval[]> {
  const staled: Approval[] = [];
  for (const approval of approvals) {
    const stale = staleApproval(approval, reason);
    await saveApproval(transaction, stale);
    await queueUpdate(transaction, stale, now);
    await audit(
      transaction,
      {
        actor: "bridge",
        action: "stale",
        linkId: stale.linkId,
        approvalId: stale.id,
        subject: reason,
      },
      now,
    );
    staled.push(stale);
  }
  return staled;
}

/**
 * Marks an approved approval applied once its patch is in, queues the update that shows it on its
 * card, and audits each field it changed on the owner's authority, under `linkId`, the link it
 * changed or made. Returns it as it's stored now.
 */
export async function recordApplied(
  transaction: Bun.SQL,
  approval: Approval,
  linkId: string,
  now: number,
): Promise<Approval> {
  const applied = applyApproval(approval, now);
  await saveApproval(transaction, applied);
  await queueUpdate(transaction, applied, now);
  await auditPatch(
    transaction,
    { actor: "owner", action: "apply", linkId, approvalId: applied.id },
    applied.patch,
    now,
  );
  return applied;
}

/** Stores a changed approval. */
export async function saveApproval(transaction: Bun.SQL, approval: Approval): Promise<void> {
  const { id, ...columns } = approvalColumns(approval);
  await transaction`UPDATE approvals SET ${transaction(columns)} WHERE id = ${id}`;
}

/**
 * Records the ts Slack gave an approval's card once the outbox has posted it, which is what lets a
 * click on it count. Returns whether it changed anything, which it doesn't once the card has a ts.
 */
export async function recordCardPosted(
  transaction: Bun.SQL,
  approvalId: string,
  ts: SlackTs,
): Promise<boolean> {
  const recorded = await transaction`
    UPDATE approvals SET card_ts = ${ts} WHERE id = ${approvalId} AND card_ts IS NULL RETURNING id
  `;
  return recorded.length > 0;
}

/**
 * Decides an interactive payload in its delivery's transaction, before the ack. A decision saves
 * the approval, queues the update that shows it on the card and audits it. Anything else changes
 * nothing, so the card stays as it was, and is audited unless it's the owner clicking again. The
 * audit names the approval a click names, whenever there's one by that ID.
 */
export async function takeClick(
  transaction: Bun.SQL,
  payload: unknown,
  now: number,
): Promise<ClickResult> {
  const interaction = readInteraction(payload);
  if (interaction.kind !== "block_actions") {
    const reason = interaction.kind === "other" ? "not_a_click" : "malformed";
    await audit(transaction, { actor: "bridge", action: "ignore_click", subject: reason }, now);
    return { kind: "ignored", reason };
  }
  const click = {
    ...interaction.click,
    userId: await canonicalUserId(transaction, interaction.click.userId),
  };
  const approvalId = clickedApprovalId(click);
  const approval = approvalId === null ? null : await readApproval(transaction, approvalId);
  const decision = decide(click, await readInstallation(transaction), approval, now);
  switch (decision.kind) {
    case "ignored": {
      // A stranger's click is someone trying to decide a card they can't, so the audit names them.
      const refused = decision.reason === "not_owner";
      await audit(
        transaction,
        {
          actor: "bridge",
          action: refused ? "refuse_click" : "ignore_click",
          linkId: approval?.linkId ?? null,
          approvalId: approval?.id ?? null,
          subject: refused ? click.userId : decision.reason,
        },
        now,
      );
      return decision;
    }
    case "unchanged":
      return decision;
    case "settled": {
      const settled = decision.approval;
      await saveApproval(transaction, settled);
      await queueUpdate(transaction, settled, now);
      await audit(
        transaction,
        {
          actor: "owner",
          action: clickAction[settled.state],
          linkId: settled.linkId,
          approvalId: settled.id,
          subject: click.userId,
        },
        now,
      );
      return { kind: "settled", approvalId: settled.id, state: settled.state };
    }
  }
}

const openStates = approvalStates.filter(isOpen);

/** Queues the update that shows an approval's card as the approval is when it's sent. */
function queueUpdate(transaction: Bun.SQL, approval: Approval, now: number): Promise<void> {
  return queueCard(
    transaction,
    {
      approvalId: approval.id,
      linkId: approval.linkId,
      channelId: approval.card.channelId,
      phase: "update",
    },
    now,
  );
}

const clickAction = {
  approved: "approve",
  rejected: "reject",
  expired: "expire",
} as const satisfies Record<ClickedState, string>;

function approvalFromRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    number: row.number,
    toyboxChannelId: row.toybox_channel_id,
    linkId: row.link_id,
    action: row.action,
    patch: JSON.parse(row.patch) as PatchEntry[],
    readSet: JSON.parse(row.read_set) as ReadSet,
    card: { channelId: row.card_channel_id, ts: row.card_ts },
    state: row.state,
    staleReason: row.stale_reason,
    appliedAt: row.applied_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    reportedAt: row.reported_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * An approval's columns but its number, which SQLite assigns and nothing changes. The owner a card
 * asks is kept in its read-set and as a column.
 */
export function approvalColumns(approval: Omit<Approval, "number">): Omit<ApprovalRow, "number"> {
  return {
    id: approval.id,
    toybox_channel_id: approval.toyboxChannelId,
    link_id: approval.linkId,
    action: approval.action,
    patch: JSON.stringify(approval.patch),
    read_set: JSON.stringify(approval.readSet),
    owner_user_id: approval.readSet.ownerUserId,
    card_channel_id: approval.card.channelId,
    card_ts: approval.card.ts,
    state: approval.state,
    stale_reason: approval.staleReason,
    applied_at: approval.appliedAt,
    decided_by: approval.decidedBy,
    decided_at: approval.decidedAt,
    reported_at: approval.reportedAt,
    created_by: approval.createdBy,
    created_at: approval.createdAt,
    expires_at: approval.expiresAt,
  };
}

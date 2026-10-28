import {
  clickedApprovalId,
  decide,
  type Approval,
  type ApprovalAction,
  type ApprovalState,
  type ClickedState,
  type IgnoredClick,
  type PatchEntry,
  type ProposalCaller,
  type ReadSet,
  type StaleReason,
} from "@links/model/approvals";
import { queueCard } from "@outbox/server/database";
import { readInteraction } from "@slackapi/model/interactions";
import type { SlackTs } from "@slackapi/model/ts";
import { readInstallation } from "@slackapi/server/installation";
import { canonicalUserId } from "@slackapi/server/users";
import { audit } from "./audit";

// Stored approvals.
//
// The receiver hands over every interactive payload in its delivery's transaction, before the ack,
// and a click is decided there from what's stored: the installation, the approval and the aliases
// of people the bridge has read. Nothing here calls Slack, so the decision commits before Slack is
// acked and a redelivered click finds it made. An approved approval applies after the ack.

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
      await queueCard(
        transaction,
        {
          approvalId: settled.id,
          linkId: settled.linkId,
          channelId: settled.card.channelId,
          phase: "update",
        },
        now,
      );
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

/** An approval's columns. The owner a card asks is kept in its read-set and as a column. */
export function approvalColumns(approval: Approval): ApprovalRow {
  return {
    id: approval.id,
    number: approval.number,
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

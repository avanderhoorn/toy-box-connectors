import {
  reverses,
  type Approval,
  type LinkField,
  type Narrowing,
  type PatchEntry,
  type ProposalCaller,
} from "@links/model/approvals";
import type { ApprovedAudience } from "@links/model/audience";
import { readOpenApprovals, staleApprovals } from "./approvals";
import { auditPatch } from "./audit";

// Narrowing.
//
// A change that narrows who can make the lead act, or who reads what it says, needs no click: it
// applies at once, in the transaction that drafts it, with an audit entry. It also voids every
// open card it reverses, so a value that changes and changes back before the owner clicks can't
// carry an old card through.

/**
 * Applies a set that only narrows `linkId`'s settings, audits each field it changes, and voids
 * the cards that change one of them. Returns the cards it voided. Publishing back to the watched
 * channel puts posts where the owner approved the audience when the link was made, so that's the
 * publish audience every later read is judged against.
 */
export async function narrowSettings(
  transaction: Bun.SQL,
  actor: ProposalCaller,
  linkId: string,
  patch: readonly PatchEntry[],
  now: number,
): Promise<Approval[]> {
  const columns: Record<string, unknown> = {};
  for (const entry of patch) columns[entry.field] = entry.after;
  if ("publish_channel_id" in columns) {
    const [link] = await transaction<{ approved_audience: string }[]>`
      SELECT approved_audience FROM links WHERE id = ${linkId}
    `;
    const approved = JSON.parse(link!.approved_audience) as ApprovedAudience;
    const audience: ApprovedAudience = {
      monitored: approved.monitored,
      publish: approved.monitored,
    };
    columns.approved_audience = JSON.stringify(audience);
  }
  await transaction`
    UPDATE links SET ${transaction({ ...columns, updated_at: now })} WHERE id = ${linkId}
  `;
  await auditPatch(transaction, { actor, action: "set", linkId }, patch, now);
  const fields = patch.map((entry) => entry.field as LinkField);
  return voidReversed(transaction, { kind: "set", linkId, fields }, now);
}

/** Voids every open card `narrowing` reverses, and returns them as they're stored now. */
export async function voidReversed(
  transaction: Bun.SQL,
  narrowing: Narrowing,
  now: number,
): Promise<Approval[]> {
  const open = await readOpenApprovals(transaction, narrowing.linkId);
  const reversed = open.filter((approval) => reverses(narrowing, approval));
  return staleApprovals(transaction, reversed, "reversed", now);
}

import type { SuspendReason } from "@links/model/status";
import { readOpenApprovals, staleApprovals } from "./approvals";
import { audit } from "./audit";

// A link's status.
//
// The owner pauses a link, and the bridge suspends one when Slack or Toy Box makes continuing
// unsafe. Either way the link keeps its settings and data until someone resumes or unlinks it.
// Every card for the link was decided against its status and reason, so a suspension stales them,
// and the owner approves resume afresh against what's true then.

/**
 * Suspends the link for `reason`, stales its open approvals and audits both. A link already
 * suspended for that reason, or because its Toy Box channel was deleted, which only unlink ends,
 * stays as it is. Returns whether anything changed.
 */
export async function suspendLink(
  transaction: Bun.SQL,
  linkId: string,
  reason: SuspendReason,
  now: number,
): Promise<boolean> {
  const suspended = await transaction`
    UPDATE links SET status = 'suspended', status_reason = ${reason}, updated_at = ${now}
    WHERE id = ${linkId} AND NOT (status = 'suspended'
      AND (status_reason IS ${reason} OR status_reason IS 'toybox_channel_deleted'))
    RETURNING id
  `;
  if (!suspended.length) return false;
  await audit(transaction, { actor: "bridge", action: "suspend", linkId, subject: reason }, now);
  await staleApprovals(
    transaction,
    await readOpenApprovals(transaction, linkId),
    "link_changed",
    now,
  );
  return true;
}

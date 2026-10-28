import type { SuspendReason } from "@links/model/status";

// A link's status.
//
// A lead or the operator pauses a link, and the bridge suspends one when Slack or Toy Box makes
// continuing unsafe. Either way the link keeps its settings and data until someone resumes or unlinks it.

/**
 * Suspends the link for `reason`. A link already suspended for that reason, or because its Toy Box
 * channel was deleted, which only unlink ends, stays as it is. Returns whether anything changed.
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
  return suspended.length > 0;
}

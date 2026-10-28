// A link's status.
//
// The owner pauses a link, and the bridge suspends one when Slack or Toy Box makes continuing
// unsafe. Either way the link keeps its settings and data until someone resumes or unlinks it.

/** Why the bridge suspended a link. */
export type SuspendReason = "toybox_channel_deleted";

/**
 * Suspends the link for `reason` and audits it, unless it's already suspended for that reason.
 * Returns whether anything changed.
 */
export async function suspendLink(
  transaction: Bun.SQL,
  linkId: string,
  reason: SuspendReason,
  now: number,
): Promise<boolean> {
  const suspended = await transaction`
    UPDATE links SET status = 'suspended', status_reason = ${reason}, updated_at = ${now}
    WHERE id = ${linkId} AND NOT (status = 'suspended' AND status_reason IS ${reason})
    RETURNING id
  `;
  if (!suspended.length) return false;
  await transaction`
    INSERT INTO audit (at, actor, action, link_id, subject)
    VALUES (${now}, 'bridge', 'suspend', ${linkId}, ${reason})
  `;
  return true;
}

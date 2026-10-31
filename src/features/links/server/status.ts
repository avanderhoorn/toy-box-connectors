import type { SuspendReason } from "@links/model/status";
import { tsAt } from "@slackapi/model/ts";
import type { ChannelLink } from "./database";

// A link's status.
//
// The owner's approval makes a link active. A lead or the operator pauses it, and the bridge
// suspends it when Slack makes continuing unsafe. Either way it keeps its settings and data until
// the owner resumes it, or until unlink deletes it.

/** A link as the owner approves it. */
type ApprovedLink = Pick<
  ChannelLink,
  "toyBoxChannelId" | "slackChannelId" | "slackChannelName" | "requestMode" | "observe" | "approved"
>;

/** Makes the link active as the owner approved it, keeping the allowlist and the rest it had. */
export async function approveLink(
  transaction: Bun.SQL,
  link: ApprovedLink,
  now: number,
): Promise<void> {
  // Never INSERT OR REPLACE, whose delete would take the link's allowlist and the rest with it.
  await transaction`
    INSERT INTO links ${transaction({
      id: crypto.randomUUID(),
      toybox_channel_id: link.toyBoxChannelId,
      slack_channel_id: link.slackChannelId,
      slack_channel_name: link.slackChannelName,
      request_mode: link.requestMode,
      observe: link.observe,
      status: "active",
      approved_audience: JSON.stringify(link.approved),
      linked_at_ts: tsAt(now),
      created_at: now,
      updated_at: now,
    })}
    ON CONFLICT (toybox_channel_id) DO UPDATE SET
      slack_channel_name = excluded.slack_channel_name,
      request_mode = excluded.request_mode, observe = excluded.observe, status = 'active',
      status_reason = NULL, approved_audience = excluded.approved_audience,
      updated_at = excluded.updated_at
  `;
}

/** Pauses the link, if it's active. */
export async function pauseLink(transaction: Bun.SQL, linkId: string, now: number): Promise<void> {
  await transaction`
    UPDATE links SET status = 'paused', updated_at = ${now} WHERE id = ${linkId} AND status = 'active'
  `;
}

/**
 * Suspends the link for `reason`. A link already suspended for that reason, or because Slack gave
 * its channel a new ID, which only unlink ends, stays as it is. Returns whether anything changed.
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
      AND (status_reason IS ${reason} OR status_reason IS 'channel_id_changed'))
    RETURNING id
  `;
  return suspended.length > 0;
}

/** Deletes a link, and with it every row that references it, such as its allowlist. */
export async function deleteLink(transaction: Bun.SQL, linkId: string): Promise<void> {
  await transaction`DELETE FROM links WHERE id = ${linkId}`;
}

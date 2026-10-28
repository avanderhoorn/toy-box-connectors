import type { SlackMessagePayload } from "@slackapi/model/messages";
import { compareTs, laterTs, tsAt, type SlackTs } from "@slackapi/model/ts";
import { RETENTION_MS } from "./ledger";

// Catch-up.
//
// History shows a message only as it stands, so catch-up finds new messages and edits but never a
// delete. It reads replies only in threads whose root it reads, no further back than the ledger
// keeps messages, so a reply on an older root is missed. Both are documented limits.

/** How long before a gap catch-up takes changes from, since Slack's clock and ours can differ. */
const GAP_MARGIN_MS = 5 * 60_000;

/**
 * What catch-up reads in a channel linked at `linkedAtTs` for a gap that began at `since`: roots
 * back to the oldest message the ledger keeps, and from them the changes made from a little before
 * the gap, but never before the link.
 */
export function catchUpWindow(
  since: number,
  linkedAtTs: SlackTs,
  now: number,
): { oldest: SlackTs; from: SlackTs } {
  const oldest = tsAt(Math.max(now - RETENTION_MS, 0));
  const gapStart = tsAt(Math.max(since - GAP_MARGIN_MS, 0));
  return { oldest, from: laterTs(laterTs(gapStart, linkedAtTs), oldest) };
}

/** Whether `message` was posted or last edited at or after `from`. */
export function changedSince(message: SlackMessagePayload, from: SlackTs): boolean {
  return compareTs(message.edited?.ts ?? message.ts, from) >= 0;
}

/** Whether the root `message` has a reply posted at or after `from`. */
export function repliedSince(message: SlackMessagePayload, from: SlackTs): boolean {
  return message.latest_reply != null && compareTs(message.latest_reply, from) >= 0;
}

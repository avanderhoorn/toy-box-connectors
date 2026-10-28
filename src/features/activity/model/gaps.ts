import { compareTs, laterTs, tsAt, type SlackTs } from "@slackapi/model/ts";

// Coverage gaps.
//
// A gap is a span of channel time the bridge may have missed. Its bounds are
// fixed when it's recorded and padded by an overlap that absorbs clock skew
// between this Mac and Slack and events delivered late. Repair merges
// idempotently, so reading a message twice costs nothing, while reading too
// little loses it.

/** How far each gap reaches past what the bridge knows it missed. */
export const gapOverlapMs = 5 * 60_000;

export type GapWindow = { oldestTs: SlackTs; latestTs: SlackTs };

/**
 * The span an app_rate_limited payload names: the minute Slack held events
 * back. Its end can still be ahead, and repair must wait for it to pass,
 * because Slack may drop events from that minute until it ends. Null when the
 * link began after the span.
 */
export function rateLimitedGap(minuteSeconds: number, linkedAtTs: SlackTs): GapWindow | null {
  const minuteMs = minuteSeconds * 1000;
  return gapWindow(minuteMs - gapOverlapMs, minuteMs + 60_000 + gapOverlapMs, linkedAtTs);
}

/**
 * The span a lost connection, a restart or an unreadable event may have hidden,
 * from the last moment the bridge knows it was receiving to the moment it knows
 * it is again. Anything later arrives live, so repair can start at once. Null
 * when the link began after the span.
 */
export function interruptionGap(
  sinceMs: number,
  untilMs: number,
  linkedAtTs: SlackTs,
): GapWindow | null {
  return gapWindow(sinceMs - gapOverlapMs, untilMs + gapOverlapMs, linkedAtTs);
}

/** The span that hydrates a whole thread: from its root to now. */
export function threadGap(rootTs: SlackTs, nowMs: number): GapWindow {
  return { oldestTs: rootTs, latestTs: laterTs(rootTs, tsAt(nowMs + gapOverlapMs)) };
}

function gapWindow(oldestMs: number, latestMs: number, linkedAtTs: SlackTs): GapWindow | null {
  const oldestTs = laterTs(tsAt(Math.max(0, oldestMs)), linkedAtTs);
  const latestTs = tsAt(Math.max(0, latestMs));
  return compareTs(oldestTs, latestTs) < 0 ? { oldestTs, latestTs } : null;
}

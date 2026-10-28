import { interruptionGap, type GapWindow } from "@activity/model/gaps";
import type { SlackTs } from "@slackapi/model/ts";
import { currentChannelId } from "@slackapi/server/channels";

// Coverage.
//
// Each gap names a span of a linked channel, or of one thread in it, that repair must read
// because the bridge may have missed part of it. Its bounds never change once it's recorded.

/** Why the bridge may have missed part of a channel or thread. */
export type GapReason =
  | "disconnect"
  | "rate_limited"
  | "malformed"
  | "startup"
  | "thread"
  /** Slack gave the channel a new ID, and events under either ID may have gone unmatched. */
  | "moved"
  /** Slack rejected the bot token, and what was posted or edited meanwhile was left for repair. */
  | "auth_failed";

export type Gap = {
  linkId: string;
  channelId: string;
  /** The thread's root, or null for the channel's own history. */
  threadTs: SlackTs | null;
  window: GapWindow;
  reason: GapReason;
};

/** A link's channel, where its channel gaps are recorded. */
export type WatchedChannel = { linkId: string; channelId: string; linkedAtTs: SlackTs };

/** The channel each link watches, whatever the link's status. */
export function readWatchedChannels(sql: Bun.SQL): Promise<WatchedChannel[]> {
  return sql<WatchedChannel[]>`
    SELECT id AS linkId, slack_channel_id AS channelId, linked_at_ts AS linkedAtTs
    FROM links ORDER BY id
  `;
}

/** Records a gap for repair to read. */
export async function recordGap(transaction: Bun.SQL, gap: Gap, now: number): Promise<void> {
  const row = {
    link_id: gap.linkId,
    channel_id: gap.channelId,
    scope: gap.threadTs === null ? "channel" : "thread",
    thread_ts: gap.threadTs,
    oldest_ts: gap.window.oldestTs,
    latest_ts: gap.window.latestTs,
    state: "open",
    reason: gap.reason,
    opened_at: now,
  };
  await transaction`INSERT INTO coverage ${transaction(row)}`;
}

/**
 * Records a channel gap for each link that watches `channelId` at its current ID, or for every
 * link when it's null, whatever the link's status. `windowFrom` bounds each by when its link began.
 */
export async function recordChannelGaps(
  transaction: Bun.SQL,
  channelId: string | null,
  reason: GapReason,
  now: number,
  windowFrom: (linkedAtTs: SlackTs) => GapWindow | null,
): Promise<void> {
  const current = channelId === null ? null : await currentChannelId(transaction, channelId);
  for (const watched of await readWatchedChannels(transaction)) {
    if (current !== null && watched.channelId !== current) continue;
    const window = windowFrom(watched.linkedAtTs);
    if (window === null) continue;
    const gap = { linkId: watched.linkId, channelId: watched.channelId, threadTs: null };
    await recordGap(transaction, { ...gap, window, reason }, now);
  }
}

/**
 * Records a gap in every linked channel for a span the bridge may have missed everywhere, from
 * `sinceMs` to `untilMs`, such as while its connection was down.
 */
export function recordInterruption(
  transaction: Bun.SQL,
  reason: GapReason,
  sinceMs: number,
  untilMs: number,
  now: number,
): Promise<void> {
  return recordChannelGaps(transaction, null, reason, now, (linkedAtTs) =>
    interruptionGap(sinceMs, untilMs, linkedAtTs),
  );
}

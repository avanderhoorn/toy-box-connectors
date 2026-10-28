import type { GapWindow } from "@activity/model/gaps";
import type { SlackTs } from "@slackapi/model/ts";

// Coverage.
//
// Each gap names a span of a linked channel, or of one thread in it, that repair must read
// because the bridge may have missed part of it. Its bounds never change once it's recorded.

/** Why the bridge may have missed part of a channel or thread. */
export type GapReason = "disconnect" | "rate_limited" | "malformed" | "startup" | "thread";

export type Gap = {
  linkId: string;
  channelId: string;
  /** The thread's root, or null for the channel's own history. */
  threadTs: SlackTs | null;
  window: GapWindow;
  reason: GapReason;
};

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

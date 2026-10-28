import type { SuspendReason } from "@links/model/status";
import type { SocketFrame } from "@slackapi/model/envelopes";
import type { ChannelChange, SlackEvent } from "@slackapi/model/events";

// Receiving from Slack.
//
// Slack redelivers an envelope it didn't see acked, so a delivery is acked only once everything it
// changes has committed, and only while Slack still waits for the ack. Taking a redelivery changes
// nothing, because the ledger merges each version of a message once and a link is suspended once.
// Besides messages, a delivery can say that a channel can't be used as the owner approved it, which
// suspends the links on it before anything relies on it again.

/**
 * How long after a delivery arrives it may still be acked. Slack waits three seconds, and the rest
 * is the ack's way back.
 */
export const ACK_DEADLINE_MS = 2_500;

/** A frame Slack wants handled. Hello and disconnect only concern the connection. */
export type SlackDelivery = Exclude<SocketFrame, { kind: "hello" } | { kind: "disconnect" }>;

/** Whether a delivery that arrived at `arrivedAt` and committed at `committedAt` may be acked. */
export function acksInTime(arrivedAt: number, committedAt: number): boolean {
  return committedAt - arrivedAt <= ACK_DEADLINE_MS;
}

/** What an event means for the links on a channel, besides any message it stores. */
export type LifecycleAction =
  /** Using the channel is unsafe until the owner decides again. */
  | { kind: "suspend"; channelId: string; reason: SuspendReason }
  /** The app was uninstalled, or our bot's token revoked. */
  | { kind: "uninstall" };

/**
 * What `event` means for the links on its channel, or null when it means nothing for them. Only a
 * change that can widen who reads the channel, or stop the bot using it, counts.
 */
export function lifecycleAction(event: SlackEvent, botUserId: string): LifecycleAction | null {
  switch (event.kind) {
    case "message": {
      // A notice is posted once, so an edit or a delete of one changes nothing about the channel.
      const { payload } = event;
      if (payload.shape !== "posted") return null;
      return suspend(payload.channel, noticeReason(payload.message.subtype ?? null));
    }
    case "membership":
      return event.userId === botUserId && event.change === "left"
        ? suspend(event.channelId, "bot_removed")
        : null;
    case "channel":
      return suspend(event.channelId, channelReason(event.change));
    case "channel_id_changed":
      return suspend(event.oldChannelId, "channel_id_changed");
    case "uninstalled":
      return { kind: "uninstall" };
    case "tokens_revoked":
      return event.botUserIds.includes(botUserId) ? { kind: "uninstall" } : null;
    case "other":
    case "malformed":
      return null;
  }
}

/** Why a notice Slack posts in a channel about the channel suspends its links, if it does. */
function noticeReason(subtype: string | null): SuspendReason | null {
  switch (subtype) {
    case "channel_convert_to_public":
      return "channel_made_public";
    case "channel_archive":
    case "group_archive":
      return "channel_archived";
    default:
      return null;
  }
}

function channelReason(change: ChannelChange): SuspendReason | null {
  switch (change) {
    case "archived":
      return "channel_archived";
    case "deleted":
      return "channel_not_found";
    case "shared":
      return "workspace_joined";
    case "renamed":
    case "unshared":
      return null;
  }
}

function suspend(channelId: string, reason: SuspendReason | null): LifecycleAction | null {
  return reason === null ? null : { kind: "suspend", channelId, reason };
}

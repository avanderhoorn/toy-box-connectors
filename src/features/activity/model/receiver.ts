import type { ChannelSuspendReason } from "@links/model/audience";
import type { SocketFrame } from "@slackapi/model/envelopes";
import type { ChannelChange, SlackEvent } from "@slackapi/model/events";

// Receiving from Slack.
//
// Slack redelivers an envelope it didn't see acked, so a delivery is acked only once everything it
// changes has committed, and only while Slack still waits for the ack. A receipt keyed by what a
// redelivery repeats turns the redelivery into a no-op. Besides messages, a delivery can say that a
// channel changed, which the links on that channel act on before anything relies on it again.

/**
 * How long after a delivery arrives it may still be acked. Slack waits three seconds, and the rest
 * is the ack's way back.
 */
export const ACK_DEADLINE_MS = 2_500;

/** A frame Slack wants handled. Hello and disconnect only concern the connection. */
export type SlackDelivery = Exclude<SocketFrame, { kind: "hello" } | { kind: "disconnect" }>;

/**
 * The key a delivery's receipt is stored under, or null when nothing a redelivery repeats names it.
 * An event keeps its ID across redeliveries and connections, and any other envelope is named by its
 * envelope. An app_rate_limited payload names one minute for one app in one workspace.
 */
export function receiptKey(delivery: SlackDelivery): string | null {
  switch (delivery.kind) {
    case "event":
      return delivery.callback.eventId;
    case "rate_limited":
      return `app_rate_limited:${delivery.appId}:${delivery.teamId}:${delivery.minute}`;
    case "other":
    case "malformed":
      return delivery.envelopeId;
  }
}

/** The type a delivery's receipt names: its event's, or its frame's when it isn't an event. */
export function receiptType(delivery: SlackDelivery): string {
  switch (delivery.kind) {
    case "event":
      return delivery.callback.event.type;
    case "rate_limited":
      return "app_rate_limited";
    case "other":
      return delivery.type;
    case "malformed":
      return "unknown";
  }
}

/** Whether a delivery that arrived at `arrivedAt` and committed at `committedAt` may be acked. */
export function acksInTime(arrivedAt: number, committedAt: number): boolean {
  return committedAt - arrivedAt <= ACK_DEADLINE_MS;
}

/** What an event means for the links on a channel, besides any message it stores. */
export type LifecycleAction =
  /** The channel changed, so its stored facts wait for a fresh read. */
  | { kind: "invalidate"; channelId: string }
  /**
   * Using the channel is unsafe until the owner resumes the link. Its facts wait for a fresh read.
   */
  | { kind: "suspend"; channelId: string; reason: ChannelSuspendReason }
  /** Slack gave the channel a new ID. */
  | { kind: "move"; oldChannelId: string; newChannelId: string }
  /** The app was uninstalled, or our bot's token revoked. */
  | { kind: "uninstall" };

/** What `event` means for the links on its channel, or null when it means nothing for them. */
export function lifecycleAction(event: SlackEvent, botUserId: string): LifecycleAction | null {
  switch (event.kind) {
    case "message": {
      // A notice is posted once, so an edit or a delete of one changes nothing about the channel.
      const { payload } = event;
      if (payload.shape !== "posted") return null;
      return noticeAction(payload.channel, payload.message.subtype ?? null);
    }
    case "membership":
      if (event.userId !== botUserId) return null;
      return event.change === "left"
        ? { kind: "suspend", channelId: event.channelId, reason: "bot_removed" }
        : { kind: "invalidate", channelId: event.channelId };
    case "channel":
      return channelAction(event.channelId, event.change);
    case "channel_id_changed":
      return { kind: "move", oldChannelId: event.oldChannelId, newChannelId: event.newChannelId };
    case "uninstalled":
      return { kind: "uninstall" };
    case "tokens_revoked":
      return event.botUserIds.includes(botUserId) ? { kind: "uninstall" } : null;
    case "file_deleted":
    case "other":
    case "malformed":
      return null;
  }
}

/** What a notice Slack posts in a channel about the channel itself means for its links. */
function noticeAction(channelId: string, subtype: string | null): LifecycleAction | null {
  switch (subtype) {
    case "channel_convert_to_public":
      return { kind: "suspend", channelId, reason: "channel_made_public" };
    case "channel_archive":
    case "group_archive":
      return { kind: "suspend", channelId, reason: "channel_archived" };
    case "channel_convert_to_private":
    case "channel_unarchive":
    case "group_unarchive":
    case "channel_name":
    case "group_name":
      return { kind: "invalidate", channelId };
    default:
      return null;
  }
}

function channelAction(channelId: string, change: ChannelChange): LifecycleAction {
  switch (change) {
    case "archived":
      return { kind: "suspend", channelId, reason: "channel_archived" };
    case "deleted":
      return { kind: "suspend", channelId, reason: "channel_not_found" };
    case "renamed":
    case "shared":
    case "unshared":
      return { kind: "invalidate", channelId };
  }
}

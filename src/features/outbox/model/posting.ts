import {
  judgeLinkChannel,
  type ApprovedAudience,
  type ChannelSuspendReason,
} from "@links/model/audience";
import type { ChannelLink } from "@links/server/database";
import type { StoredRequest } from "@requests/server/database";
import type { Installation } from "@slackapi/model/installation";
import { compareTs } from "@slackapi/model/ts";
import type { ChannelInfo } from "@slackapi/server/channels";
import type { OutboxItem } from "../server/database";

type PostIntent = Pick<
  OutboxItem,
  "kind" | "phase" | "linkId" | "requestId" | "requestRev" | "channelId" | "threadTs"
>;

/** The current link, not the settings under which the item was queued. */
export type PostingLink = Pick<ChannelLink, "id" | "status" | "allowlist"> & {
  slackChannelId: string;
  publishChannelId: string;
  approved: ApprovedAudience;
};

export type PostingPermission =
  | { kind: "allowed" }
  | { kind: "waiting"; reason: "installation_inactive" | "link_inactive" | "source_unverified" }
  | { kind: "refresh"; channelId: string }
  | { kind: "superseded"; revision: number }
  | {
      kind: "failed";
      error:
        | "invalid_post"
        | "link_removed"
        | "destination_changed"
        | "request_missing"
        | "requester_denied"
        | "request_closed"
        | "request_not_ready";
    }
  | { kind: "held"; reason: "workspaces_unknown" }
  | { kind: "suspended"; reason: ChannelSuspendReason };

/** Send-time authority for lead-authored posts. Cleanup and feedback have separate gates. */
export function postingPermission(
  post: PostIntent,
  installation: Installation | null,
  link: PostingLink | null,
  request: StoredRequest | null,
  channel: ChannelInfo | null,
  now: number,
): PostingPermission {
  if (!installation || installation.status !== "active") {
    return { kind: "waiting", reason: "installation_inactive" };
  }
  if (!link || link.id !== post.linkId) return { kind: "failed", error: "link_removed" };
  if (link.status !== "active") return { kind: "waiting", reason: "link_inactive" };
  if (post.kind === "publication") {
    if (post.channelId !== link.publishChannelId || post.threadTs !== null) {
      return { kind: "failed", error: "destination_changed" };
    }
  } else if (post.kind === "reply" || post.kind === "progress") {
    if (!request || request.id !== post.requestId || request.linkId !== link.id) {
      return { kind: "failed", error: "request_missing" };
    }
    if (
      post.channelId !== link.slackChannelId ||
      post.channelId !== request.channelId ||
      post.threadTs === null ||
      compareTs(post.threadTs, request.rootTs) !== 0
    ) {
      return { kind: "failed", error: "destination_changed" };
    }
    if (post.requestRev !== request.inputRev) {
      return { kind: "superseded", revision: request.inputRev };
    }
    if (!link.allowlist.has(request.requesterUserId)) {
      return { kind: "failed", error: "requester_denied" };
    }
    if (request.state === "cancelled") return { kind: "failed", error: "request_closed" };
    const ready =
      post.kind === "progress"
        ? request.state === "seen" || request.state === "in_progress"
        : post.phase === "follow_up"
          ? ["answered", "dismissed", "expired"].includes(request.state)
          : post.phase === "final" && request.state === "answering";
    if (!ready) return { kind: "failed", error: "request_not_ready" };
    if (request.sourceUnverifiedAt !== null) {
      return { kind: "waiting", reason: "source_unverified" };
    }
  } else {
    return { kind: "failed", error: "invalid_post" };
  }
  if (
    !channel ||
    channel.facts.id !== post.channelId ||
    channel.invalidatedAt !== null ||
    channel.refreshedAt > now ||
    now - channel.refreshedAt >= 120_000
  ) {
    return { kind: "refresh", channelId: post.channelId };
  }
  const audience = judgeLinkChannel(
    link.approved,
    {
      monitored: post.channelId === link.slackChannelId,
      publish: post.channelId === link.publishChannelId,
    },
    channel.facts,
    installation,
  );
  return audience.kind === "approved" ? { kind: "allowed" } : audience;
}

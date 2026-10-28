import type { ChannelSuspendReason } from "@links/model/audience";
import { channelFailureReason } from "@slackapi/model/errors";
import type { Installation } from "@slackapi/model/installation";
import { slackMessageSchema } from "@slackapi/model/messages";
import { compareTs, slackTsSchema, type SlackTs } from "@slackapi/model/ts";
import type { SlackCall } from "@slackapi/server/botClient";
import { z } from "zod";

export type OutboxMethod =
  | "chat.postMessage"
  | "chat.update"
  | "chat.delete"
  | "reactions.add"
  | "reactions.remove"
  | "assistant.threads.setStatus";

export type WriteOutcome<Result> =
  | { kind: "accepted"; result: Result }
  | { kind: "queued"; nextAttemptAt: number | null; error: string }
  | { kind: "delivery_unknown"; error: string }
  | { kind: "failed"; error: string; suspend: ChannelSuspendReason | null };

/** The shared client already owns authentication failures and method cooldowns. */
export function writeOutcome<Result>(call: SlackCall<Result>): WriteOutcome<Result> {
  switch (call.kind) {
    case "ok":
      return { kind: "accepted", result: call.result };
    case "auth_failed":
      return { kind: "queued", nextAttemptAt: null, error: call.error };
    case "rate_limited":
      return { kind: "queued", nextAttemptAt: call.until, error: "rate_limited" };
    case "unknown":
      return { kind: "delivery_unknown", error: call.detail };
    case "error":
      if (["internal_error", "fatal_error", "service_unavailable"].includes(call.error)) {
        return { kind: "delivery_unknown", error: call.error };
      }
      return { kind: "failed", error: call.error, suspend: channelFailureReason(call.error) };
  }
}

/** What a queued post expects to find in Slack, including its exact sent fallback. */
export type OutboxPost = {
  id: string;
  payloadHash: string;
  channelId: string;
  threadTs: SlackTs | null;
  text: string;
};

type BotIdentity = Pick<Installation, "appId" | "botId">;

const metadataSchema = z.object({
  event_type: z.literal("toy_box_outbox"),
  event_payload: z.object({ id: z.string(), payload_hash: z.string() }),
});

/** Metadata is opaque correlation, not message content or a Slack-side deduplication key. */
export function outboxMetadata(post: Pick<OutboxPost, "id" | "payloadHash">) {
  return {
    event_type: "toy_box_outbox",
    event_payload: { id: post.id, payload_hash: post.payloadHash },
  };
}

export const deliveryMessageSchema = slackMessageSchema.extend({
  channel: z.string().min(1).nullish(),
  bot_profile: z
    .object({ id: z.string().min(1).nullish(), app_id: z.string().min(1).nullish() })
    .nullish(),
  metadata: z.unknown().optional(),
});

type DeliveryMessage = z.output<typeof deliveryMessageSchema>;

const receiptSchema = z.object({
  ok: z.literal(true),
  channel: z.string().min(1),
  ts: slackTsSchema,
  message: deliveryMessageSchema,
  warning: z.string().nullish(),
  response_metadata: z.object({ warnings: z.array(z.string()).nullish() }).nullish(),
});

export type PostReceipt =
  | { kind: "confirmed"; ts: SlackTs; metadataOk: boolean }
  | { kind: "misplaced"; ts: SlackTs; metadataOk: boolean }
  | { kind: "unverified"; reason: "invalid_response" | "wrong_channel" | "wrong_author" };

/** A successful write proves acceptance. It does not excuse a reply landing at the root. */
export function postReceipt(result: unknown, post: OutboxPost, identity: BotIdentity): PostReceipt {
  const parsed = receiptSchema.safeParse(result);
  if (!parsed.success) return { kind: "unverified", reason: "invalid_response" };
  const receipt = parsed.data;
  if (compareTs(receipt.ts, receipt.message.ts) !== 0 || !currentMessage(receipt.message)) {
    return { kind: "unverified", reason: "invalid_response" };
  }
  if (
    receipt.channel !== post.channelId ||
    (receipt.message.channel != null && receipt.message.channel !== post.channelId)
  ) {
    return { kind: "unverified", reason: "wrong_channel" };
  }
  if (conflictingIdentity(receipt.message, identity)) {
    return { kind: "unverified", reason: "wrong_author" };
  }
  const warnings = [receipt.warning ?? "", ...(receipt.response_metadata?.warnings ?? [])];
  const metadataOk =
    matchesMetadata(receipt.message.metadata, post) &&
    !warnings.some((warning) => warning.toLowerCase().includes("metadata"));
  return {
    kind: correctThread(receipt.message, post.threadTs) ? "confirmed" : "misplaced",
    ts: receipt.ts,
    metadataOk,
  };
}

/**
 * A read proves delivery only with our bot and app, the exact destination and metadata.
 * A manual resolution may additionally verify exact text, but only when metadata is absent.
 */
export function messageEvidence(
  message: unknown,
  channelId: string,
  post: OutboxPost,
  identity: BotIdentity,
  manual = false,
): "metadata" | "text" | null {
  const parsed = deliveryMessageSchema.safeParse(message);
  if (!parsed.success || channelId !== post.channelId) return null;
  const candidate = parsed.data;
  if (candidate.channel != null && candidate.channel !== channelId) return null;
  if (
    !currentMessage(candidate) ||
    !fromOurBot(candidate, identity) ||
    !correctThread(candidate, post.threadTs)
  ) {
    return null;
  }
  if (candidate.metadata != null) {
    return matchesMetadata(candidate.metadata, post) ? "metadata" : null;
  }
  return manual && candidate.text === post.text ? "text" : null;
}

/** Three bounded reads, never permission to resend when none finds evidence. */
export function nextReconciliation(attemptAt: number, completedPasses: number): number | null {
  if (!Number.isSafeInteger(attemptAt) || attemptAt < 0) {
    throw new RangeError("Reconciliation needs a nonnegative attempt time");
  }
  if (!Number.isInteger(completedPasses) || completedPasses < 0 || completedPasses > 3) {
    throw new RangeError("Reconciliation has between zero and three completed passes");
  }
  const delay = [10_000, 60_000, 120_000][completedPasses];
  return delay === undefined ? null : attemptAt + delay;
}

function matchesMetadata(metadata: unknown, post: Pick<OutboxPost, "id" | "payloadHash">): boolean {
  const parsed = metadataSchema.safeParse(metadata);
  return (
    parsed.success &&
    parsed.data.event_payload.id === post.id &&
    parsed.data.event_payload.payload_hash === post.payloadHash
  );
}

function correctThread(message: DeliveryMessage, threadTs: SlackTs | null): boolean {
  if (message.subtype === "thread_broadcast") return false;
  const actual = message.thread_ts ?? null;
  if (threadTs === null) return actual === null || compareTs(actual, message.ts) === 0;
  return (
    actual !== null && compareTs(actual, threadTs) === 0 && compareTs(message.ts, threadTs) !== 0
  );
}

function currentMessage(message: DeliveryMessage): boolean {
  return !["tombstone", "message_changed", "message_deleted", "message_replied"].includes(
    message.subtype ?? "",
  );
}

function conflictingIdentity(message: DeliveryMessage, identity: BotIdentity): boolean {
  return (
    (message.bot_id != null && message.bot_id !== identity.botId) ||
    (message.bot_profile?.id != null && message.bot_profile.id !== identity.botId) ||
    (message.app_id != null && message.app_id !== identity.appId) ||
    (message.bot_profile?.app_id != null && message.bot_profile.app_id !== identity.appId)
  );
}

function fromOurBot(message: DeliveryMessage, identity: BotIdentity): boolean {
  return (
    !conflictingIdentity(message, identity) &&
    message.bot_id === identity.botId &&
    (message.app_id === identity.appId || message.bot_profile?.app_id === identity.appId)
  );
}

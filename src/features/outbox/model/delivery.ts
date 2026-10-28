import type { ChannelSuspendReason } from "@links/model/audience";
import { channelFailureReason } from "@slackapi/model/errors";
import type { Installation } from "@slackapi/model/installation";
import { isWithdrawn, slackMessageSchema } from "@slackapi/model/messages";
import { compareTs, slackTsSchema, type SlackTs } from "@slackapi/model/ts";
import type { SlackCall } from "@slackapi/server/botClient";
import { z } from "zod";

export type WriteOutcome<Result> =
  | { kind: "accepted"; result: Result }
  | { kind: "queued"; nextAttemptAt: number | null; error: string }
  | { kind: "delivery_unknown"; error: string }
  | { kind: "failed"; error: string; suspend: ChannelSuspendReason | null };

export function writeOutcome<Result>(call: SlackCall<Result>): WriteOutcome<Result> {
  switch (call.kind) {
    case "ok":
      return { kind: "accepted", result: call.result };
    case "auth_failed":
      return { kind: "queued", nextAttemptAt: null, error: call.error };
    case "rate_limited":
      return { kind: "queued", nextAttemptAt: call.until, error: "rate_limited" };
    case "unknown":
      return { kind: "delivery_unknown", error: "unverified_slack_response" };
    case "error":
      return ["internal_error", "fatal_error", "service_unavailable"].includes(call.error)
        ? { kind: "delivery_unknown", error: call.error }
        : { kind: "failed", error: call.error, suspend: channelFailureReason(call.error) };
  }
}

export type OutboxPost = {
  id: string;
  payloadHash: string;
  channelId: string;
  threadTs: SlackTs | null;
};
type BotIdentity = Pick<Installation, "appId" | "botId">;
const metadataSchema = z.object({
  event_type: z.literal("toy_box_outbox"),
  event_payload: z.object({ id: z.string(), payload_hash: z.string() }),
});
export function outboxMetadata(post: Pick<OutboxPost, "id" | "payloadHash">) {
  return {
    event_type: "toy_box_outbox",
    event_payload: { id: post.id, payload_hash: post.payloadHash },
  };
}
const messageSchema = slackMessageSchema.extend({
  channel: z.string().min(1).nullish(),
  bot_profile: z.object({ id: z.string().nullish(), app_id: z.string().nullish() }).nullish(),
  metadata: z.unknown().optional(),
});
type DeliveryMessage = z.output<typeof messageSchema>;
const receiptSchema = z.object({
  ok: z.literal(true),
  channel: z.string().min(1),
  ts: slackTsSchema,
  message: messageSchema,
});
export type PostReceipt =
  | { kind: "confirmed"; ts: SlackTs }
  | { kind: "misplaced"; ts: SlackTs }
  | { kind: "unverified"; reason: "invalid_response" | "wrong_channel" | "wrong_author" };

export function postReceipt(result: unknown, post: OutboxPost, identity: BotIdentity): PostReceipt {
  const parsed = receiptSchema.safeParse(result);
  if (!parsed.success) return { kind: "unverified", reason: "invalid_response" };
  const receipt = parsed.data;
  if (compareTs(receipt.ts, receipt.message.ts) !== 0 || !currentMessage(receipt.message))
    return { kind: "unverified", reason: "invalid_response" };
  if (
    receipt.channel !== post.channelId ||
    (receipt.message.channel != null && receipt.message.channel !== post.channelId)
  )
    return { kind: "unverified", reason: "wrong_channel" };
  if (conflictingIdentity(receipt.message, identity))
    return { kind: "unverified", reason: "wrong_author" };
  return {
    kind: correctThread(receipt.message, post.threadTs) ? "confirmed" : "misplaced",
    ts: receipt.ts,
  };
}

/** Reads prove only positive, exact correlation. Missing or matching text proves nothing. */
export function reconciliationReceipt(
  message: unknown,
  channelId: string,
  post: OutboxPost,
  identity: BotIdentity,
): SlackTs | null {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success || channelId !== post.channelId) return null;
  const candidate = parsed.data;
  const metadata = metadataSchema.safeParse(candidate.metadata);
  return currentMessage(candidate) &&
    correctThread(candidate, post.threadTs) &&
    (candidate.channel == null || candidate.channel === channelId) &&
    !conflictingIdentity(candidate, identity) &&
    candidate.bot_id === identity.botId &&
    (candidate.app_id === identity.appId || candidate.bot_profile?.app_id === identity.appId) &&
    metadata.success &&
    metadata.data.event_payload.id === post.id &&
    metadata.data.event_payload.payload_hash === post.payloadHash
    ? candidate.ts
    : null;
}

export function deleteReceipt(
  result: unknown,
  target: { channelId: string; ts: SlackTs },
): boolean {
  const parsed = receiptSchema.pick({ ok: true, channel: true, ts: true }).safeParse(result);
  return (
    parsed.success &&
    parsed.data.channel === target.channelId &&
    compareTs(parsed.data.ts, target.ts) === 0
  );
}

export function nextReconciliation(attemptAt: number, completedPasses: number): number | null {
  if (
    !Number.isSafeInteger(attemptAt) ||
    attemptAt < 0 ||
    !Number.isInteger(completedPasses) ||
    completedPasses < 0 ||
    completedPasses > 2
  )
    throw new RangeError("Invalid reconciliation clock or pass.");
  const delay = [60_000, 300_000][completedPasses];
  return delay === undefined ? null : attemptAt + delay;
}

function correctThread(message: DeliveryMessage, threadTs: SlackTs | null): boolean {
  if (message.subtype === "thread_broadcast") return false;
  const actual = message.thread_ts ?? null;
  return threadTs === null
    ? actual === null || compareTs(actual, message.ts) === 0
    : actual !== null && compareTs(actual, threadTs) === 0 && compareTs(message.ts, threadTs) !== 0;
}
function currentMessage(message: DeliveryMessage): boolean {
  return (
    !isWithdrawn(message) &&
    !["tombstone", "message_changed", "message_deleted", "message_replied"].includes(
      message.subtype ?? "",
    )
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

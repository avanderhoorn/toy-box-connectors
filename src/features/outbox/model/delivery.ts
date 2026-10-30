import { RETENTION_MS } from "@activity/model/ledger";
import type { Installation } from "@slackapi/model/installation";
import { isWithdrawn, slackMessageSchema } from "@slackapi/model/messages";
import { compareTs, slackTsSchema, type SlackTs } from "@slackapi/model/ts";
import type { SlackCall } from "@slackapi/server/botClient";
import { z } from "zod";

export type OutboxSettlement =
  | { state: "sent"; slackTs: SlackTs }
  | { state: "queued"; error: string; nextAttemptAt: number | null }
  | { state: "delivery_unknown"; error: string; slackTs?: SlackTs }
  | { state: "failed"; error: string };

export function postSettlement(
  call: SlackCall<unknown>,
  post: OutboxPost,
  identity: BotIdentity,
): OutboxSettlement {
  switch (call.kind) {
    case "ok":
      return postReceipt(call.result, post, identity);
    case "auth_failed":
      return { state: "queued", nextAttemptAt: null, error: call.error };
    case "rate_limited":
      return { state: "queued", nextAttemptAt: call.until, error: "rate_limited" };
    case "unknown":
      return { state: "delivery_unknown", error: "unverified_slack_response" };
    case "error":
      return ["internal_error", "fatal_error", "service_unavailable"].includes(call.error)
        ? { state: "delivery_unknown", error: call.error }
        : { state: "failed", error: call.error };
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

function postReceipt(result: unknown, post: OutboxPost, identity: BotIdentity): OutboxSettlement {
  const parsed = receiptSchema.safeParse(result);
  if (!parsed.success) return { state: "delivery_unknown", error: "invalid_response" };
  const receipt = parsed.data;
  if (compareTs(receipt.ts, receipt.message.ts) !== 0 || !currentMessage(receipt.message))
    return { state: "delivery_unknown", error: "invalid_response" };
  if (
    receipt.channel !== post.channelId ||
    (receipt.message.channel != null && receipt.message.channel !== post.channelId)
  )
    return { state: "delivery_unknown", error: "wrong_channel" };
  if (conflictingIdentity(receipt.message, identity))
    return { state: "delivery_unknown", error: "wrong_author" };
  return correctThread(receipt.message, post.threadTs)
    ? { state: "sent", slackTs: receipt.ts }
    : { state: "delivery_unknown", error: "wrong_thread", slackTs: receipt.ts };
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

/** How long after an attempt each of the two checks for an unknown post runs. */
export const reconciliationDelays = [60_000, 300_000] as const;

export function nextReconciliation(attemptAt: number, completedPasses: number): number | null {
  const delay = reconciliationDelays[completedPasses];
  return delay === undefined ? null : attemptAt + delay;
}

/**
 * When to ask Slack again to delete a file it kept: a minute after the first try, doubling to
 * hourly, until 30 days after the bridge first owed the delete, as long as it keeps a post.
 */
export function nextDeletion(owedAt: number, attempts: number, at: number): number | null {
  if (at - owedAt >= RETENTION_MS) return null;
  return at + Math.min(3_600_000, 60_000 * 2 ** attempts);
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

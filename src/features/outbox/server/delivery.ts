import type { ChannelSuspendReason } from "@links/model/audience";
import { recordCardPosted } from "@links/server/approvals";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { isActive } from "@requests/model/lifecycle";
import { readRequest } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import { settleRequestAnswer } from "./answers";
import {
  queueRetraction,
  readOutboxItem,
  settleOutboxAttempt,
  type OutboxItem,
  type OutboxSettlement,
} from "./database";

const threadRefusals = new Set([
  "thread_not_found",
  "restricted_action_thread_locked",
  "cannot_reply_to_message",
  "restricted_action_non_threadable_channel",
]);

/** A response and a metadata read commit the same proof, cleanup and request effects. */
export async function settleDelivery(
  tx: Bun.SQL,
  item: OutboxItem,
  outcome: OutboxSettlement,
  now: number,
  suspend: ChannelSuspendReason | null = null,
): Promise<OutboxItem | null> {
  const settled = await settleOutboxAttempt(tx, item, outcome, now);
  if (!settled) return null;
  if (suspend !== null) await suspendChannelLinks(tx, item.channelId, suspend, now);
  if (
    settled.state === "sent" &&
    item.kind === "card" &&
    item.phase === "post" &&
    item.approvalId !== null
  ) {
    if (settled.slackTs === null) throw new Error("A confirmed card has no Slack timestamp.");
    await recordCardPosted(tx, item.approvalId, settled.slackTs);
  }
  if (settled.state === "stray") {
    await queueRetraction(tx, settled, now);
  }
  if (
    settled.state === "stray" ||
    (settled.state === "failed" && settled.error !== null && threadRefusals.has(settled.error))
  ) {
    await cancelThreadRequest(tx, settled, now);
  }
  if (item.requestId !== null) await settleRequestAnswer(tx, item.requestId, now);
  return settled;
}

/** A refused or misplaced reply closes only an active request in its own scope. */
export async function cancelThreadRequest(
  tx: Bun.SQL,
  item: OutboxItem,
  now: number,
): Promise<void> {
  if (!["reply", "progress"].includes(item.kind) || item.requestId === null) return;
  const request = await readRequest(tx, item.requestId);
  if (
    request &&
    isActive(request.state) &&
    request.linkId === item.linkId &&
    request.channelId === item.channelId &&
    request.rootTs === item.threadTs
  ) {
    await cancelStoredRequest(tx, request, "thread_gone", now);
  }
}

/** A local refusal returns a final reply's request without inventing a network attempt. */
export async function settleQueuedDelivery(
  tx: Bun.SQL,
  item: OutboxItem,
  state: "failed" | "dropped" | "superseded",
  error: string,
  now: number,
): Promise<OutboxItem | null> {
  const changed = await tx`
    UPDATE outbox SET state = ${state}, error = ${error}, next_attempt_at = NULL, updated_at = ${now}
    WHERE id = ${item.id} AND state = 'queued' AND attempts = ${item.attempts}
      AND payload_hash = ${item.payloadHash} RETURNING id
  `;
  if (changed.length === 0) return null;
  const settled = await readOutboxItem(tx, item.id);
  if (item.kind === "reply" && item.phase === "final" && item.requestId !== null) {
    await settleRequestAnswer(tx, item.requestId, now);
  }
  return settled;
}

/** A shared cooldown can extend, but never shorten, a queued item's own deadline. */
export async function deferQueuedDelivery(
  tx: Bun.SQL,
  id: string,
  reason: string,
  until: number,
  now: number,
): Promise<number | null> {
  const item = await readOutboxItem(tx, id);
  if (!item || item.state !== "queued") return null;
  const next = Math.max(until, item.nextAttemptAt ?? 0);
  await tx`
    UPDATE outbox SET error = ${reason}, next_attempt_at = ${next}, updated_at = ${now}
    WHERE id = ${id} AND state = 'queued'
  `;
  return next;
}

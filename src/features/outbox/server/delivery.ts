import type { ChannelSuspendReason } from "@links/model/audience";
import { recordCardPosted } from "@links/server/approvals";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { settleRequestAnswer } from "./answers";
import {
  queueRetraction,
  readOutboxItem,
  settleOutboxAttempt,
  type OutboxItem,
  type OutboxSettlement,
} from "./database";

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
  if (item.requestId !== null) await settleRequestAnswer(tx, item.requestId, now);
  return settled;
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

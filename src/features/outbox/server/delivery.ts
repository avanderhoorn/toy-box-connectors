import type { ChannelSuspendReason } from "@links/model/audience";
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
  if (settled.state === "stray") {
    await queueRetraction(tx, settled, now);
  }
  if (item.requestId !== null) await settleRequestAnswer(tx, item.requestId, now);
  await purgeRemovedLinkItem(tx, settled);
  return settled;
}

/** An item without a link is not an orphan of a link that was removed. */
export async function linkWasRemoved(tx: Bun.SQL, linkId: string | null): Promise<boolean> {
  if (linkId === null) return false;
  const [link] = await tx`SELECT id FROM links WHERE id = ${linkId}`;
  return !link;
}

/** Retire a settled or forgotten orphan. */
export async function purgeRemovedLinkItem(tx: Bun.SQL, item: OutboxItem): Promise<void> {
  if (!(await linkWasRemoved(tx, item.linkId))) return;
  if (["sending", "delivery_unknown", "stray"].includes(item.state)) return;
  if (["reply", "progress", "publication"].includes(item.kind)) {
    await tx`DELETE FROM outbox WHERE id = ${item.id}`;
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
  if (settled) await purgeRemovedLinkItem(tx, settled);
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

import type { SlackTs } from "@slackapi/model/ts";

// Stored outbox items.
//
// An item is queued in the transaction of whatever owes it and numbered after every item before
// it. Cards and reactions carry only what names their target, because a card is rendered from its
// approval when it's sent.

/** An item to queue, by column. Queueing assigns its ID, number, payload hash and state. */
export type NewOutboxItem = {
  kind: "reply" | "progress" | "publication" | "retract" | "card" | "reaction" | "status";
  /** final or follow_up for a reply, post or update for a card. */
  phase?: string | null;
  linkId?: string | null;
  requestId?: number | null;
  approvalId?: string | null;
  /** The request revision a reply answers. */
  requestRev?: number | null;
  channelId: string;
  threadTs?: SlackTs | null;
  publicationKey?: string | null;
  /** The ID of the item a publication replaces. */
  replaces?: string | null;
  payload: Record<string, unknown>;
};

/**
 * Cancels a request's replies and progress notes that are still queued. One already sending may
 * still land, so it's left to finish.
 */
export async function cancelQueuedRequestItems(
  transaction: Bun.SQL,
  requestId: number,
  now: number,
): Promise<void> {
  await transaction`
    UPDATE outbox SET state = 'cancelled', updated_at = ${now}
    WHERE request_id = ${requestId} AND state = 'queued' AND kind IN ('reply', 'progress')
  `;
}

/** Queues adding the reaction `name` to a message, such as ✅ on a claim the terminal confirmed. */
export async function queueReaction(
  transaction: Bun.SQL,
  reaction: { channelId: string; ts: SlackTs; name: string; linkId?: string | null },
  now: number,
): Promise<void> {
  await queueItem(
    transaction,
    {
      kind: "reaction",
      linkId: reaction.linkId,
      channelId: reaction.channelId,
      payload: { action: "add", name: reaction.name, timestamp: reaction.ts },
    },
    now,
  );
}

/**
 * Queues posting an approval's card, or updating it to show the approval as it is when the update
 * is sent. A new update supersedes the approval's updates still queued, and an update waits until
 * the post it edits has landed.
 */
export async function queueCard(
  transaction: Bun.SQL,
  card: { approvalId: string; linkId: string | null; channelId: string; phase: "post" | "update" },
  now: number,
): Promise<void> {
  if (card.phase === "update") {
    await transaction`
      UPDATE outbox SET state = 'superseded', updated_at = ${now}
      WHERE approval_id = ${card.approvalId} AND kind = 'card' AND phase = 'update'
        AND state = 'queued'
    `;
  }
  await queueItem(transaction, { kind: "card", ...card, payload: {} }, now);
}

/**
 * Readdresses every item for a channel, sent or not, to the new ID Slack gave it, so a post still
 * to send, an update or a retraction reaches the channel.
 */
export async function moveOutboxChannel(
  transaction: Bun.SQL,
  oldId: string,
  newId: string,
): Promise<void> {
  await transaction`UPDATE outbox SET channel_id = ${newId} WHERE channel_id = ${oldId}`;
}

/** Queues an item after every item before it. Returns the ID and number it's known by. */
export async function queueItem(
  transaction: Bun.SQL,
  item: NewOutboxItem,
  now: number,
): Promise<{ id: string; number: number }> {
  const payload = JSON.stringify(item.payload);
  const [queued] = await transaction<{ id: string; number: number }[]>`
    INSERT INTO outbox (
      id, number, link_id, request_id, approval_id, request_rev, kind, phase, channel_id,
      thread_ts, publication_key, replaces, payload, payload_hash, state, created_at, updated_at
    )
    VALUES (
      ${crypto.randomUUID()}, (SELECT COALESCE(MAX(number), 0) + 1 FROM outbox),
      ${item.linkId ?? null}, ${item.requestId ?? null}, ${item.approvalId ?? null},
      ${item.requestRev ?? null}, ${item.kind}, ${item.phase ?? null}, ${item.channelId},
      ${item.threadTs ?? null}, ${item.publicationKey ?? null}, ${item.replaces ?? null},
      ${payload}, ${Bun.SHA256.hash(payload, "hex")}, 'queued', ${now}, ${now}
    )
    RETURNING id, number
  `;
  return queued!;
}

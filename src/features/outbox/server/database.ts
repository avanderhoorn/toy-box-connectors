import type { SlackTs } from "@slackapi/model/ts";
import { channelFailureReason } from "@slackapi/model/errors";
import { z } from "zod";
import { nextReconciliation, type OutboxMethod } from "../model/delivery";

// Stored outbox items.
//
// An item is queued in the transaction of whatever owes it and numbered after every item there has
// ever been, so a purge never lets a number the lead still holds name another item. Cards and
// reactions carry only what names their target, because a card is rendered from its approval when
// it's sent.

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

export type OutboxState =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "delivery_unknown"
  | "stray"
  | "superseded"
  | "retracted"
  | "dropped"
  | "cancelled"
  | "skipped";

type DeliveryEvidence = "response" | "metadata" | "text";

export type OutboxItem = {
  id: string;
  number: number;
  linkId: string | null;
  requestId: number | null;
  approvalId: string | null;
  requestRev: number | null;
  kind: NewOutboxItem["kind"];
  phase: "final" | "follow_up" | "post" | "update" | null;
  channelId: string;
  threadTs: SlackTs | null;
  publicationKey: string | null;
  replaces: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  metadataOk: boolean | null;
  state: OutboxState;
  attempts: number;
  attemptMethod: OutboxMethod | null;
  attemptStartedAt: number | null;
  reconcilePass: number;
  nextAttemptAt: number | null;
  slackTs: SlackTs | null;
  error: string | null;
  evidence: DeliveryEvidence | null;
  createdAt: number;
  updatedAt: number;
};

type OutboxRow = {
  id: string;
  number: number;
  link_id: string | null;
  request_id: number | null;
  approval_id: string | null;
  request_rev: number | null;
  kind: NewOutboxItem["kind"];
  phase: OutboxItem["phase"];
  channel_id: string;
  thread_ts: SlackTs | null;
  publication_key: string | null;
  replaces: string | null;
  payload: string;
  payload_hash: string;
  metadata_ok: 0 | 1 | null;
  state: OutboxState;
  attempts: number;
  attempt_method: OutboxMethod | null;
  attempt_started_at: number | null;
  reconcile_pass: number;
  next_attempt_at: number | null;
  slack_ts: SlackTs | null;
  error: string | null;
  evidence: DeliveryEvidence | null;
  created_at: number;
  updated_at: number;
};

export type OutboxSettlement =
  | {
      state: "sent";
      slackTs: SlackTs | null;
      evidence: DeliveryEvidence;
      metadataOk: boolean | null;
    }
  | { state: "queued" | "delivery_unknown"; error: string; nextAttemptAt: number | null }
  | { state: "failed" | "dropped"; error: string }
  | {
      state: "stray";
      slackTs: SlackTs;
      error: string;
      evidence: DeliveryEvidence;
      metadataOk: boolean | null;
      nextAttemptAt: number | null;
    };

type AttemptStart =
  | { kind: "started"; item: OutboxItem }
  | { kind: "waiting"; reason: "retry_after" | "card_in_flight" | "post_slot"; until: number }
  | { kind: "changed" };

/** Reads an opaque ID, or the number shown to the lead as o31. */
export async function readOutboxItem(
  sql: Bun.SQL,
  reference: string | number,
): Promise<OutboxItem | null> {
  const [row] =
    typeof reference === "number"
      ? await sql<OutboxRow[]>`SELECT * FROM outbox WHERE number = ${reference}`
      : await sql<OutboxRow[]>`SELECT * FROM outbox WHERE id = ${reference}`;
  return row ? outboxItem(row) : null;
}

/** Feedback comes last. Only idempotent cleanup and feedback can retry an unknown operation. */
export async function readReadyOutbox(sql: Bun.SQL, now: number): Promise<OutboxItem[]> {
  const rows = await sql<OutboxRow[]>`
    SELECT * FROM outbox WHERE (state = 'queued' OR (state = 'delivery_unknown'
      AND kind IN ('retract', 'reaction', 'status')))
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
    ORDER BY CASE kind
      WHEN 'retract' THEN 0 WHEN 'reply' THEN 1 WHEN 'publication' THEN 1
      WHEN 'card' THEN 2 WHEN 'progress' THEN 3 ELSE 4 END, number
  `;
  return rows.map(outboxItem);
}

/** Exhausted linked work stops; stopped orphans remain due for local disposal. */
export async function readDueReconciliations(sql: Bun.SQL, now: number): Promise<OutboxItem[]> {
  const rows = await sql<
    (OutboxRow & { owner_link_id: string | null; link_status: string | null })[]
  >`
    SELECT outbox.*, COALESCE(approvals.link_id, outbox.link_id) AS owner_link_id,
      links.status AS link_status FROM outbox
    LEFT JOIN approvals ON outbox.kind = 'card' AND approvals.id = outbox.approval_id
    LEFT JOIN links ON links.id = COALESCE(approvals.link_id, outbox.link_id)
    WHERE outbox.state = 'delivery_unknown' AND outbox.kind IN ('reply', 'progress', 'publication', 'card')
      AND (outbox.reconcile_pass < 3
      OR (owner_link_id IS NOT NULL AND links.id IS NULL))
      AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= ${now})
    ORDER BY outbox.next_attempt_at, outbox.number
  `;
  return rows
    .filter(
      (row) =>
        (row.owner_link_id !== null && row.link_status === null) ||
        (channelFailureReason(row.error ?? "") !== null
          ? row.link_status === "active"
          : row.next_attempt_at !== null),
    )
    .map(outboxItem);
}

/**
 * Commits the exact send-time payload and its hash with sending. Call in the transaction that
 * rechecked policy, then make the network call only after it commits. Only chat.postMessage takes
 * a channel slot; edits, retractions and feedback don't consume a post's turn.
 */
export async function startOutboxAttempt(
  transaction: Bun.SQL,
  item: OutboxItem,
  payload: Record<string, unknown>,
  method: OutboxMethod,
  now: number,
): Promise<AttemptStart> {
  const postsMessage = method === "chat.postMessage";
  const current = await readOutboxItem(transaction, item.id);
  if (
    !current ||
    current.state !== "queued" ||
    current.attempts !== item.attempts ||
    current.payloadHash !== item.payloadHash ||
    current.channelId !== item.channelId ||
    current.updatedAt !== item.updatedAt
  ) {
    return { kind: "changed" };
  }
  if (current.nextAttemptAt !== null && current.nextAttemptAt > now) {
    return { kind: "waiting", reason: "retry_after", until: current.nextAttemptAt };
  }
  if (current.kind === "card" && current.approvalId !== null) {
    const [sending] = await transaction<{ id: string }[]>`
      SELECT id FROM outbox WHERE kind = 'card' AND approval_id = ${current.approvalId}
        AND state = 'sending' AND id <> ${current.id} LIMIT 1
    `;
    if (sending) return { kind: "waiting", reason: "card_in_flight", until: now + 1_000 };
  }
  if (postsMessage) {
    const [slot] = await transaction<{ next_post_at: number }[]>`
      SELECT next_post_at FROM outbox_channels WHERE channel_id = ${current.channelId}
    `;
    if (slot && slot.next_post_at > now) {
      return { kind: "waiting", reason: "post_slot", until: slot.next_post_at };
    }
  }
  const encoded = encodePayload(payload);
  if (
    current.attempts > 0 &&
    ((current.kind !== "card" && encoded.hash !== current.payloadHash) ||
      (current.attemptMethod !== null && current.attemptMethod !== method))
  ) {
    throw new Error(`Retry o${current.number} with its stored method and payload snapshot.`);
  }
  const [row] = await transaction<OutboxRow[]>`
    UPDATE outbox SET state = 'sending', attempts = attempts + 1,
      attempt_method = ${method}, attempt_started_at = ${now},
      reconcile_pass = 0, next_attempt_at = NULL, error = NULL,
      payload = ${encoded.text}, payload_hash = ${encoded.hash}, updated_at = ${now}
    WHERE id = ${current.id}
    RETURNING *
  `;
  if (postsMessage) {
    await transaction`
      INSERT INTO outbox_channels (channel_id, next_post_at)
      VALUES (${current.channelId}, ${now + 1_000})
      ON CONFLICT (channel_id) DO UPDATE SET next_post_at = excluded.next_post_at
    `;
  }
  return { kind: "started", item: outboxItem(row!) };
}

/**
 * Settles only the attempt the caller observed. A late response or reconciliation cannot
 * overwrite a manual resolution, a newer attempt, or a card's newer payload snapshot.
 */
export async function settleOutboxAttempt(
  transaction: Bun.SQL,
  item: OutboxItem,
  outcome: OutboxSettlement,
  now: number,
): Promise<OutboxItem | null> {
  const allowed =
    item.state === "sending" ||
    (item.state === "delivery_unknown" &&
      (["sent", "delivery_unknown", "stray"].includes(outcome.state) ||
        (item.attemptMethod !== null && item.attemptMethod !== "chat.postMessage"))) ||
    (item.state === "stray" && ["stray", "failed"].includes(outcome.state));
  if (!allowed) {
    throw new Error(
      `Outbox item o${item.number} cannot settle from ${item.state} to ${outcome.state}.`,
    );
  }
  const metadataOk = "metadataOk" in outcome ? outcome.metadataOk : item.metadataOk;
  const [row] = await transaction<OutboxRow[]>`
    UPDATE outbox SET state = ${outcome.state},
      slack_ts = ${"slackTs" in outcome ? outcome.slackTs : item.slackTs},
      evidence = ${"evidence" in outcome ? outcome.evidence : item.evidence},
      metadata_ok = ${metadataOk === null ? null : Number(metadataOk)},
      next_attempt_at = ${"nextAttemptAt" in outcome ? outcome.nextAttemptAt : null},
      error = ${"error" in outcome ? outcome.error : null}, updated_at = ${now}
    WHERE id = ${item.id} AND attempts = ${item.attempts}
      AND payload_hash = ${item.payloadHash} AND state = ${item.state}
      AND state IN ('sending', 'delivery_unknown', 'stray')
    RETURNING *
  `;
  if (
    row &&
    item.kind === "card" &&
    item.phase === "update" &&
    item.approvalId !== null &&
    (outcome.state === "queued" || outcome.state === "delivery_unknown")
  ) {
    await supersedeCardUpdates(transaction, item.approvalId, now);
    return readOutboxItem(transaction, item.id);
  }
  return row ? outboxItem(row) : null;
}

/** Record a fully read, unsuccessful pass. Rate-limited or partial reads must not spend a pass. */
export async function advanceReconciliation(
  transaction: Bun.SQL,
  item: OutboxItem,
  now: number,
): Promise<OutboxItem | null> {
  if (item.state !== "delivery_unknown" || item.reconcilePass === 3) return null;
  if (item.attemptStartedAt === null) {
    throw new Error(`Outbox item o${item.number} has no attempt time for reconciliation.`);
  }
  const pass = item.reconcilePass + 1;
  const next = nextReconciliation(item.attemptStartedAt, pass);
  const [row] = await transaction<OutboxRow[]>`
    UPDATE outbox SET reconcile_pass = ${pass}, next_attempt_at = ${next}, updated_at = ${now}
    WHERE id = ${item.id} AND state = 'delivery_unknown' AND attempts = ${item.attempts}
      AND payload_hash = ${item.payloadHash} AND reconcile_pass = ${item.reconcilePass}
      AND next_attempt_at IS NOT NULL AND next_attempt_at <= ${now}
    RETURNING *
  `;
  return row ? outboxItem(row) : null;
}

/** Startup never retries a write interrupted after its sending transaction committed. */
export async function recoverOutboxAttempts(transaction: Bun.SQL, now: number): Promise<string[]> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE outbox SET state = 'delivery_unknown', error = 'interrupted',
      attempt_started_at = COALESCE(attempt_started_at, created_at), reconcile_pass = 0,
      next_attempt_at = MAX(${now}, COALESCE(attempt_started_at, created_at) + 10000),
      updated_at = ${now}
    WHERE state = 'sending'
    RETURNING id
  `;
  await supersedeCardUpdates(transaction, null, now);
  return rows.map((row) => row.id);
}

/** Expired post slots carry no content or continuing delivery obligation. */
export async function expirePostSlots(transaction: Bun.SQL, now: number): Promise<void> {
  await transaction`DELETE FROM outbox_channels WHERE next_post_at <= ${now}`;
}

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

/** Queues adding or removing a reaction, such as ✅ on a claim the terminal confirmed. */
export async function queueReaction(
  transaction: Bun.SQL,
  reaction: {
    channelId: string;
    ts: SlackTs;
    name: string;
    action?: "add" | "remove";
    linkId?: string | null;
    requestId?: number | null;
  },
  now: number,
): Promise<void> {
  if (reaction.action === "remove") {
    const [queued] = await transaction`
      SELECT id FROM outbox WHERE kind = 'reaction' AND state = 'queued'
        AND channel_id = ${reaction.channelId}
        AND link_id IS ${reaction.linkId ?? null} AND request_id IS ${reaction.requestId ?? null}
        AND json_extract(payload, '$.action') = 'remove'
        AND json_extract(payload, '$.name') = ${reaction.name}
        AND json_extract(payload, '$.timestamp') = ${reaction.ts}
      LIMIT 1
    `;
    if (queued) return;
  }
  await queueItem(
    transaction,
    {
      kind: "reaction",
      linkId: reaction.linkId,
      requestId: reaction.requestId,
      channelId: reaction.channelId,
      payload: { action: reaction.action ?? "add", name: reaction.name, timestamp: reaction.ts },
    },
    now,
  );
}

/**
 * Queues posting an approval's card, or updating it to show the approval as it is when the update
 * is sent. A new update supersedes older queued or unknown updates. A sending one finishes first,
 * and its settlement or startup recovery supersedes it if its result still needs another attempt.
 */
export async function queueCard(
  transaction: Bun.SQL,
  card: { approvalId: string; linkId: string | null; channelId: string; phase: "post" | "update" },
  now: number,
): Promise<void> {
  await queueItem(transaction, { kind: "card", ...card, payload: {} }, now);
  if (card.phase === "update") await supersedeCardUpdates(transaction, card.approvalId, now);
}

/** Repeated cleanup or an explicit retract shares the outstanding operation for this item. */
export async function queueRetraction(
  transaction: Bun.SQL,
  target: OutboxItem,
  now: number,
): Promise<{ id: string; number: number }> {
  const [existing] = await transaction<{ id: string; number: number }[]>`
    SELECT id, number FROM outbox WHERE kind = 'retract'
      AND json_extract(payload, '$.target') = ${target.id}
      AND channel_id = ${target.channelId} AND link_id IS ${target.linkId}
      AND request_id IS ${target.requestId} AND thread_ts IS ${target.threadTs}
      AND state IN ('queued', 'sending', 'delivery_unknown', 'sent')
    ORDER BY number DESC LIMIT 1
  `;
  return (
    existing ??
    queueItem(
      transaction,
      {
        kind: "retract",
        linkId: target.linkId,
        requestId: target.requestId,
        channelId: target.channelId,
        threadTs: target.threadTs,
        payload: { target: target.id },
      },
      now,
    )
  );
}

/**
 * Lets go of the card of an approval whose link is gone once nothing more can happen to it, and
 * returns whether it did, after which the approval can go too. `posted` says the card reached
 * Slack. A queued post goes at once, so no card reaches Slack for a link that's gone, and so do
 * the updates of a card no post can still bring there. While any other row of the card, or a
 * withdrawal of one, is queued or unsettled, everything stays, so delivery can still render and
 * settle it. Then it all goes, but for a post that reached the wrong place, which stays redacted
 * with one more withdrawal queued.
 */
export async function forgetCard(
  transaction: Bun.SQL,
  approvalId: string,
  posted: boolean,
  now: number,
): Promise<boolean> {
  await transaction`
    DELETE FROM outbox
    WHERE kind = 'card' AND phase = 'post' AND approval_id = ${approvalId} AND state = 'queued'
  `;
  if (!posted) {
    await transaction`
      DELETE FROM outbox
      WHERE kind = 'card' AND phase = 'update' AND approval_id = ${approvalId} AND state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM outbox AS post WHERE post.kind = 'card' AND post.phase = 'post'
            AND post.approval_id = ${approvalId} AND post.state IN ('sending', 'delivery_unknown')
        )
    `;
  }
  const [unsettled] = await transaction`
    SELECT id FROM outbox
    WHERE state IN ('queued', 'sending', 'delivery_unknown') AND (
      (kind = 'card' AND approval_id = ${approvalId})
      OR (kind = 'retract' AND json_extract(payload, '$.target') IN (
        SELECT id FROM outbox WHERE kind = 'card' AND approval_id = ${approvalId}
      ))
    )
    LIMIT 1
  `;
  if (unsettled) return false;
  const strays = await transaction<OutboxRow[]>`
    SELECT * FROM outbox
    WHERE kind = 'card' AND phase = 'post' AND approval_id = ${approvalId} AND state = 'stray'
    ORDER BY number
  `;
  await transaction`
    DELETE FROM outbox WHERE kind = 'retract' AND json_extract(payload, '$.target') IN (
      SELECT id FROM outbox WHERE kind = 'card' AND approval_id = ${approvalId}
    )
  `;
  await transaction`
    DELETE FROM outbox WHERE kind = 'card' AND approval_id = ${approvalId}
      AND NOT (phase = 'post' AND state = 'stray')
  `;
  for (const stray of strays.map(outboxItem)) {
    await redact(transaction, stray);
    await queueRetraction(transaction, stray, now);
  }
  return true;
}

/** Forgets what a kept item says once what it was about is gone. Its hash still names its attempt. */
async function redact(transaction: Bun.SQL, item: OutboxItem): Promise<void> {
  await transaction`UPDATE outbox SET payload = ${REDACTED} WHERE id = ${item.id}`;
}

const REDACTED = JSON.stringify({ redacted: "unlink" });

async function supersedeCardUpdates(
  transaction: Bun.SQL,
  approvalId: string | null,
  now: number,
): Promise<void> {
  await transaction`
    UPDATE outbox SET state = 'superseded', next_attempt_at = NULL, updated_at = ${now}
    WHERE kind = 'card' AND phase = 'update' AND state IN ('queued', 'delivery_unknown')
      AND (${approvalId} IS NULL OR approval_id = ${approvalId})
      AND EXISTS (
        SELECT 1 FROM outbox AS newer WHERE newer.kind = 'card' AND newer.phase = 'update'
          AND newer.approval_id = outbox.approval_id AND newer.number > outbox.number
      )
  `;
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
  await transaction`
    INSERT INTO outbox_channels (channel_id, next_post_at)
    SELECT ${newId}, next_post_at FROM outbox_channels WHERE channel_id = ${oldId}
    ON CONFLICT (channel_id) DO UPDATE
      SET next_post_at = MAX(outbox_channels.next_post_at, excluded.next_post_at)
  `;
  await transaction`
    DELETE FROM outbox_channels WHERE channel_id = ${oldId} AND channel_id <> ${newId}
  `;
}

/** Queues an item after every item before it. Returns the ID and number it's known by. */
export async function queueItem(
  transaction: Bun.SQL,
  item: NewOutboxItem,
  now: number,
): Promise<{ id: string; number: number }> {
  const payload = encodePayload(item.payload);
  const [queued] = await transaction<{ id: string; number: number }[]>`
    INSERT INTO outbox (
      id, link_id, request_id, approval_id, request_rev, kind, phase, channel_id,
      thread_ts, publication_key, replaces, payload, payload_hash, state, created_at, updated_at
    )
    VALUES (
      ${crypto.randomUUID()},
      ${item.linkId ?? null}, ${item.requestId ?? null}, ${item.approvalId ?? null},
      ${item.requestRev ?? null}, ${item.kind}, ${item.phase ?? null}, ${item.channelId},
      ${item.threadTs ?? null}, ${item.publicationKey ?? null}, ${item.replaces ?? null},
      ${payload.text}, ${payload.hash}, 'queued', ${now}, ${now}
    )
    RETURNING id, number
  `;
  return queued!;
}

function encodePayload(payload: Record<string, unknown>): { text: string; hash: string } {
  if (Object.hasOwn(payload, "metadata")) {
    throw new Error("Outbox snapshots must not contain Slack metadata. Add it at call time.");
  }
  const text = JSON.stringify(payload);
  return { text, hash: Bun.SHA256.hash(text, "hex") };
}

const payloadSchema = z.record(z.string(), z.unknown());

function outboxItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    number: row.number,
    linkId: row.link_id,
    requestId: row.request_id,
    approvalId: row.approval_id,
    requestRev: row.request_rev,
    kind: row.kind,
    phase: row.phase,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    publicationKey: row.publication_key,
    replaces: row.replaces,
    payload: payloadSchema.parse(JSON.parse(row.payload)),
    payloadHash: row.payload_hash,
    metadataOk: row.metadata_ok === null ? null : row.metadata_ok === 1,
    state: row.state,
    attempts: row.attempts,
    attemptMethod: row.attempt_method,
    attemptStartedAt: row.attempt_started_at,
    reconcilePass: row.reconcile_pass,
    nextAttemptAt: row.next_attempt_at,
    slackTs: row.slack_ts,
    error: row.error,
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

import { RETENTION_MS } from "@activity/model/ledger";
import { readChannelLink } from "@links/server/database";
import {
  beginAnswer,
  confirmAnswer,
  RequestStateError,
  returnToSeen,
} from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { canonicalUserId } from "@slackapi/server/users";
import type { SlackTs } from "@slackapi/model/ts";
import { z } from "zod";
import { nextReconciliation, reconciliationDelays, type OutboxSettlement } from "../model/delivery";
import { renderMarkdown, type RenderedMessage } from "../model/rendering";

export class OutboxRefusedError extends Error {}
export type OutboxState =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "delivery_unknown"
  | "retracted";
export type OutboxItem = {
  id: string;
  number: number;
  linkId: string;
  requestId: number | null;
  kind: "reply" | "publication";
  channelId: string;
  threadTs: SlackTs | null;
  series: string | null;
  scheduledAt: number | null;
  /** What the post says, until the bridge forgets it. A post that may still go out has it. */
  payload: Record<string, unknown> | null;
  payloadHash: string;
  state: OutboxState;
  attempts: number;
  attemptStartedAt: number | null;
  nextAttemptAt: number | null;
  reconcilePass: number;
  slackTs: SlackTs | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
type OutboxRow = {
  id: string;
  number: number;
  link_id: string;
  request_id: number | null;
  kind: OutboxItem["kind"];
  channel_id: string;
  thread_ts: SlackTs | null;
  series: string | null;
  scheduled_at: number | null;
  payload: string | null;
  payload_hash: string;
  state: OutboxState;
  attempts: number;
  attempt_started_at: number | null;
  next_attempt_at: number | null;
  reconcile_pass: number;
  slack_ts: SlackTs | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export async function queueReply(
  tx: Bun.SQL,
  input: { requestId: number; text: string },
  now: number,
): Promise<OutboxItem> {
  const [existing] = await tx<
    OutboxRow[]
  >`SELECT * FROM outbox WHERE request_id = ${input.requestId}`;
  if (existing && existing.state !== "failed")
    throw new OutboxRefusedError(
      `Request r${input.requestId} is already reserved by o${existing.number} (${existing.state}).`,
    );
  const request = await readRequest(tx, input.requestId);
  if (!request) throw new OutboxRefusedError(`Request r${input.requestId} no longer exists.`);
  const link = await readChannelLink(tx, request.channelId);
  if (!link || link.id !== request.linkId || link.status !== "active")
    throw new OutboxRefusedError("This request's link isn't active.");
  if (!link.allowlist.has(await canonicalUserId(tx, request.requesterUserId)))
    throw new OutboxRefusedError("This requester is no longer allowed.");
  const payload = rendered(input.text);
  try {
    await saveRequest(tx, beginAnswer(request, now));
  } catch (error) {
    if (!(error instanceof RequestStateError)) throw error;
    throw new OutboxRefusedError(error.message);
  }
  return existing
    ? retryFailed(tx, existing.id, payload, now)
    : insertItem(
        tx,
        {
          linkId: request.linkId,
          requestId: request.id,
          kind: "reply",
          channelId: request.channelId,
          threadTs: request.rootTs,
          series: null,
          scheduledAt: null,
        },
        payload,
        now,
      );
}

export async function queuePublication(
  tx: Bun.SQL,
  input: { linkId: string; series: string; scheduledAt: number; text: string },
  now: number,
): Promise<OutboxItem> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.series) ||
    !Number.isSafeInteger(input.scheduledAt) ||
    input.scheduledAt < 0 ||
    input.scheduledAt > now
  )
    throw new OutboxRefusedError(
      "A publication needs a series name and its scheduled slot at or before now.",
    );
  const [existing] = await tx<OutboxRow[]>`
    SELECT * FROM outbox WHERE link_id = ${input.linkId} AND series = ${input.series}
      AND scheduled_at = ${input.scheduledAt}
  `;
  if (existing && existing.state !== "failed")
    throw new OutboxRefusedError(
      `This publication slot is already reserved by o${existing.number} (${existing.state}).`,
    );
  const [link] = await tx<{ slack_channel_id: string; status: string }[]>`
    SELECT slack_channel_id, status FROM links WHERE id = ${input.linkId}
  `;
  if (!link || link.status !== "active") throw new OutboxRefusedError("This link isn't active.");
  const payload = rendered(input.text);
  return existing
    ? retryFailed(tx, existing.id, payload, now)
    : insertItem(
        tx,
        {
          ...input,
          requestId: null,
          kind: "publication",
          channelId: link.slack_channel_id,
          threadTs: null,
        },
        payload,
        now,
      );
}

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

export async function readReadyOutbox(sql: Bun.SQL, now: number): Promise<OutboxItem[]> {
  const rows = await sql<OutboxRow[]>`
    SELECT outbox.* FROM outbox JOIN links ON links.id = outbox.link_id
    WHERE outbox.state = 'queued' AND links.status = 'active'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}) ORDER BY number LIMIT 100
  `;
  return rows.map(outboxItem);
}

export async function readDueReconciliations(sql: Bun.SQL, now: number): Promise<OutboxItem[]> {
  const rows = await sql<OutboxRow[]>`
    SELECT outbox.* FROM outbox JOIN links ON links.id = outbox.link_id
    WHERE outbox.state = 'delivery_unknown' AND links.status = 'active'
      AND reconcile_pass < 2 AND next_attempt_at <= ${now} ORDER BY next_attempt_at, number LIMIT 100
  `;
  return rows.map(outboxItem);
}

/** Call only after policy checks, then commit before invoking Slack. */
export async function startOutboxAttempt(tx: Bun.SQL, item: OutboxItem, now: number) {
  const [row] = await tx<OutboxRow[]>`
    UPDATE outbox SET state = 'sending', attempts = attempts + 1, attempt_started_at = ${now},
      next_attempt_at = NULL, error = NULL, updated_at = ${now}
    WHERE id = ${item.id} AND state = 'queued' AND attempts = ${item.attempts}
      AND payload_hash = ${item.payloadHash} RETURNING *
  `;
  return row ? outboxItem(row) : null;
}

/** A late response cannot settle a newer attempt, or resurrect an unlinked item. */
export async function settleOutboxAttempt(
  tx: Bun.SQL,
  item: OutboxItem,
  outcome: OutboxSettlement,
  now: number,
): Promise<OutboxItem | null> {
  const unknown = outcome.state === "delivery_unknown";
  const next =
    outcome.state === "queued"
      ? outcome.nextAttemptAt
      : unknown
        ? nextReconciliation(item.attemptStartedAt!, 0)
        : null;
  const ts =
    outcome.state === "sent" ? outcome.slackTs : unknown ? (outcome.slackTs ?? null) : null;
  const [row] = await tx<OutboxRow[]>`
    UPDATE outbox SET state = ${outcome.state}, slack_ts = ${ts},
      error = ${outcome.state === "sent" ? null : outcome.error}, next_attempt_at = ${next},
      updated_at = ${now}
    WHERE id = ${item.id} AND state = ${item.state} AND state IN ('sending', 'delivery_unknown')
      AND (state = 'sending' OR ${outcome.state} = 'sent')
      AND attempts = ${item.attempts} AND payload_hash = ${item.payloadHash} RETURNING *
  `;
  if (!row) return null;
  const settled = outboxItem(row);
  await settleRequest(tx, settled, now);
  return settled;
}

export async function failQueuedItem(
  tx: Bun.SQL,
  item: OutboxItem,
  error: string,
  now: number,
): Promise<OutboxItem | null> {
  const [row] = await tx<OutboxRow[]>`
    UPDATE outbox SET state = 'failed', error = ${error}, next_attempt_at = NULL, updated_at = ${now}
    WHERE id = ${item.id} AND state = 'queued' AND attempts = ${item.attempts} RETURNING *
  `;
  if (!row) return null;
  const settled = outboxItem(row);
  await settleRequest(tx, settled, now);
  return settled;
}

/**
 * Fails every item the link holds queued, in the order they were queued, giving each reply's
 * request back to the lead. One sending, or whose delivery is unknown, may have posted, so it stays.
 */
export async function failQueuedItems(
  tx: Bun.SQL,
  linkId: string,
  error: string,
  now: number,
): Promise<OutboxItem[]> {
  const rows = await tx<OutboxRow[]>`
    SELECT * FROM outbox WHERE link_id = ${linkId} AND state = 'queued' ORDER BY number
  `;
  const failed: OutboxItem[] = [];
  for (const row of rows) {
    const item = await failQueuedItem(tx, outboxItem(row), error, now);
    if (item) failed.push(item);
  }
  return failed;
}

export async function advanceReconciliation(
  tx: Bun.SQL,
  item: OutboxItem,
  error: string | null,
  until: number | null,
  now: number,
) {
  const pass = item.reconcilePass + (error === null ? 1 : 0);
  await tx`
    UPDATE outbox SET reconcile_pass = ${pass}, error = ${error ?? item.error},
      next_attempt_at = ${error === null ? nextReconciliation(item.attemptStartedAt!, pass) : until},
      updated_at = ${now}
    WHERE id = ${item.id} AND state = 'delivery_unknown' AND attempts = ${item.attempts}
      AND reconcile_pass = ${item.reconcilePass}
  `;
}

export async function recoverOutboxAttempts(tx: Bun.SQL, now: number): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    UPDATE outbox SET state = 'delivery_unknown', error = 'interrupted_send',
      next_attempt_at = attempt_started_at + ${reconciliationDelays[0]}, updated_at = ${now}
    WHERE state = 'sending' RETURNING id
  `;
  return rows.map((row) => row.id);
}

/**
 * Forgets what each post said once it can't go out anymore and hasn't changed for as long as the
 * bridge keeps what was said. Its row stays, so nothing it reserved posts again.
 */
export async function forgetOldPosts(tx: Bun.SQL, now: number): Promise<void> {
  await tx`
    UPDATE outbox SET payload = NULL
    WHERE payload IS NOT NULL AND state NOT IN ('queued', 'sending')
      AND updated_at < ${now - RETENTION_MS}
  `;
}

function rendered(text: string): RenderedMessage {
  const result = renderMarkdown(text);
  if (result.kind === "refused") {
    const problem =
      result.problem === "message_too_long"
        ? `${result.actual} escaped characters exceeds ${result.limit}. Shorten the text`
        : result.problem === "empty"
          ? "Provide nonblank text"
          : `Remove credentials (${result.problem})`;
    throw new OutboxRefusedError(`Cannot post: ${problem}.`);
  }
  return result.message;
}

async function settleRequest(tx: Bun.SQL, item: OutboxItem, now: number): Promise<void> {
  if (item.requestId === null) return;
  const request = await readRequest(tx, item.requestId);
  if (request?.state !== "answering") return;
  if (item.state === "sent") await saveRequest(tx, confirmAnswer(request));
  if (item.state === "failed") await saveRequest(tx, returnToSeen(request, now));
}

async function retryFailed(
  tx: Bun.SQL,
  id: string,
  payload: RenderedMessage,
  now: number,
): Promise<OutboxItem> {
  const [row] = await tx<OutboxRow[]>`
    UPDATE outbox SET state = 'queued', payload = ${JSON.stringify(payload)}, payload_hash = ${hash(payload)},
      next_attempt_at = NULL, error = NULL, updated_at = ${now} WHERE id = ${id} AND state = 'failed' RETURNING *
  `;
  return outboxItem(row!);
}

async function insertItem(
  tx: Bun.SQL,
  item: Pick<
    OutboxItem,
    "linkId" | "requestId" | "kind" | "channelId" | "threadTs" | "series" | "scheduledAt"
  >,
  payload: RenderedMessage,
  now: number,
): Promise<OutboxItem> {
  const [row] = await tx<OutboxRow[]>`
    INSERT INTO outbox ${tx({
      id: crypto.randomUUID(),
      link_id: item.linkId,
      request_id: item.requestId,
      kind: item.kind,
      channel_id: item.channelId,
      thread_ts: item.threadTs,
      series: item.series,
      scheduled_at: item.scheduledAt,
      payload: JSON.stringify(payload),
      payload_hash: hash(payload),
      state: "queued",
      created_at: now,
      updated_at: now,
    })} RETURNING *
  `;
  return outboxItem(row!);
}

function hash(payload: RenderedMessage): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex");
}

function outboxItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    number: row.number,
    linkId: row.link_id,
    requestId: row.request_id,
    kind: row.kind,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    series: row.series,
    scheduledAt: row.scheduled_at,
    payload:
      row.payload === null
        ? null
        : z.record(z.string(), z.unknown()).parse(JSON.parse(row.payload)),
    payloadHash: row.payload_hash,
    state: row.state,
    attempts: row.attempts,
    attemptStartedAt: row.attempt_started_at,
    nextAttemptAt: row.next_attempt_at,
    reconcilePass: row.reconcile_pass,
    slackTs: row.slack_ts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

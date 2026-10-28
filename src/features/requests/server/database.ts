import {
  inputSource,
  isActive,
  requestStates,
  type Request,
  type RequestAttention,
  type RequestInput,
  type RequestReason,
  type RequestState,
} from "@requests/model/lifecycle";
import { compareTs, type SlackTs } from "@slackapi/model/ts";

// Stored requests.
//
// A request's row changes only by saving what a lifecycle function returned for it, in the
// transaction of whatever caused the change. A message belongs to at most one request.

/** A request and the ID the lead sees it by. */
export type StoredRequest = Request & { id: number };

type RequestRow = {
  id: number;
  link_id: string;
  channel_id: string;
  root_ts: SlackTs;
  source_ts: SlackTs;
  requester_user_id: string;
  reason: RequestReason;
  state: RequestState;
  input_rev: number;
  input_hash: string;
  served_rev: number;
  attention: RequestAttention | null;
  source_unverified_at: number | null;
  held_at: number | null;
  hold_reason: string | null;
  late: number;
  created_at: number;
  changed_at: number;
  seen_at: number | null;
  touched_at: number | null;
  reminded_at: number | null;
  progress_ts: SlackTs | null;
  expires_at: number;
  closed_reason: string | null;
  closed_reported_at: number | null;
};

type InputRow = { ts: SlackTs; deleted: number; content_hash: string | null };

const activeStates = requestStates.filter(isActive);

export async function readRequest(sql: Bun.SQL, id: number): Promise<StoredRequest | null> {
  const [row] = await sql<RequestRow[]>`SELECT * FROM requests WHERE id = ${id}`;
  return row ? requestFromRow(row) : null;
}

/** The request a person has active in a thread, which their later messages there join. */
export async function readActiveRequest(
  sql: Bun.SQL,
  linkId: string,
  requesterUserId: string,
  rootTs: SlackTs,
): Promise<StoredRequest | null> {
  const [row] = await sql<RequestRow[]>`
    SELECT * FROM requests
    WHERE link_id = ${linkId} AND requester_user_id = ${requesterUserId} AND root_ts = ${rootTs}
      AND state IN ${sql(activeStates)}
  `;
  return row ? requestFromRow(row) : null;
}

/** A link's open, seen, in-progress and answering requests, oldest first. */
export async function readActiveRequests(sql: Bun.SQL, linkId: string): Promise<StoredRequest[]> {
  const rows = await sql<RequestRow[]>`
    SELECT * FROM requests WHERE link_id = ${linkId} AND state IN ${sql(activeStates)} ORDER BY id
  `;
  return rows.map(requestFromRow);
}

/** Every link's active requests whose lifetime ended by `now`, oldest first. */
export async function readOverdueRequests(sql: Bun.SQL, now: number): Promise<StoredRequest[]> {
  const rows = await sql<RequestRow[]>`
    SELECT * FROM requests
    WHERE state IN ${sql(activeStates)} AND expires_at <= ${now} ORDER BY id
  `;
  return rows.map(requestFromRow);
}

/**
 * A link's requests the lead read that were cancelled or expired since inbox last said so, oldest
 * first.
 */
export async function readUnreportedEndings(
  sql: Bun.SQL,
  linkId: string,
): Promise<StoredRequest[]> {
  const rows = await sql<RequestRow[]>`
    SELECT * FROM requests
    WHERE link_id = ${linkId} AND state IN ('cancelled', 'expired') AND seen_at IS NOT NULL
      AND closed_reported_at IS NULL
    ORDER BY id
  `;
  return rows.map(requestFromRow);
}

/** A link's requests held since before `heldBefore`. */
export async function readHeldRequests(
  sql: Bun.SQL,
  linkId: string,
  heldBefore: number,
): Promise<StoredRequest[]> {
  const rows = await sql<RequestRow[]>`
    SELECT * FROM requests WHERE link_id = ${linkId} AND held_at < ${heldBefore} ORDER BY id
  `;
  return rows.map(requestFromRow);
}

/** The request a message belongs to, whatever its state. */
export async function readMessageRequest(
  sql: Bun.SQL,
  channelId: string,
  ts: SlackTs,
): Promise<StoredRequest | null> {
  const [row] = await sql<RequestRow[]>`
    SELECT requests.* FROM request_messages
    JOIN requests ON requests.id = request_messages.request_id
    WHERE request_messages.channel_id = ${channelId} AND request_messages.ts = ${ts}
  `;
  return row ? requestFromRow(row) : null;
}

/** Whether a person started a request in a thread before `ts`, whatever became of it. */
export async function askedBefore(
  sql: Bun.SQL,
  linkId: string,
  requesterUserId: string,
  rootTs: SlackTs,
  ts: SlackTs,
): Promise<boolean> {
  const requests = await sql<{ source_ts: SlackTs }[]>`
    SELECT source_ts FROM requests
    WHERE link_id = ${linkId} AND requester_user_id = ${requesterUserId} AND root_ts = ${rootTs}
  `;
  return requests.some((request) => compareTs(request.source_ts, ts) < 0);
}

export async function insertRequest(
  transaction: Bun.SQL,
  request: Request,
): Promise<StoredRequest> {
  const [row] = await transaction<RequestRow[]>`
    INSERT INTO requests ${transaction(requestColumns(request))} RETURNING *
  `;
  return requestFromRow(row!);
}

/** Saves what a lifecycle function returned for a stored request. */
export async function saveRequest(transaction: Bun.SQL, request: StoredRequest): Promise<void> {
  const { id, ...rest } = request;
  await transaction`UPDATE requests SET ${transaction(requestColumns(rest))} WHERE id = ${id}`;
}

/** Makes a message one of a request's, taking it from any request it belonged to. */
export async function assignRequestMessage(
  transaction: Bun.SQL,
  requestId: number,
  channelId: string,
  ts: SlackTs,
): Promise<void> {
  await transaction`
    INSERT INTO request_messages (request_id, channel_id, ts)
    VALUES (${requestId}, ${channelId}, ${ts})
    ON CONFLICT (channel_id, ts) DO UPDATE SET request_id = excluded.request_id
  `;
}

/** Follows a channel Slack gave a new ID, so its requests and their messages name the new one. */
export async function moveRequestChannel(
  transaction: Bun.SQL,
  oldId: string,
  newId: string,
): Promise<void> {
  await transaction`UPDATE requests SET channel_id = ${newId} WHERE channel_id = ${oldId}`;
  await transaction`UPDATE request_messages SET channel_id = ${newId} WHERE channel_id = ${oldId}`;
}

/** Hashes a request's input, so any change to which messages it has or what they say shows. */
export function hashInput(messages: readonly RequestInput[]): string {
  return Bun.SHA256.hash(inputSource(messages), "hex");
}

/** The input hash of a request's messages as the ledger holds them now. */
export async function readInputHash(sql: Bun.SQL, requestId: number): Promise<string> {
  const rows = await sql<InputRow[]>`
    SELECT messages.ts, messages.deleted, messages.content_hash
    FROM request_messages
    JOIN messages
      ON messages.channel_id = request_messages.channel_id AND messages.ts = request_messages.ts
    WHERE request_messages.request_id = ${requestId}
  `;
  return hashInput(
    rows.map((row) => ({ ts: row.ts, deleted: row.deleted === 1, contentHash: row.content_hash })),
  );
}

function requestFromRow(row: RequestRow): StoredRequest {
  return {
    id: row.id,
    linkId: row.link_id,
    channelId: row.channel_id,
    rootTs: row.root_ts,
    sourceTs: row.source_ts,
    requesterUserId: row.requester_user_id,
    reason: row.reason,
    state: row.state,
    inputRev: row.input_rev,
    inputHash: row.input_hash,
    servedRev: row.served_rev,
    attention: row.attention,
    sourceUnverifiedAt: row.source_unverified_at,
    heldAt: row.held_at,
    holdReason: row.hold_reason,
    late: row.late === 1,
    createdAt: row.created_at,
    changedAt: row.changed_at,
    seenAt: row.seen_at,
    touchedAt: row.touched_at,
    remindedAt: row.reminded_at,
    progressTs: row.progress_ts,
    expiresAt: row.expires_at,
    closedReason: row.closed_reason,
    closedReportedAt: row.closed_reported_at,
  };
}

function requestColumns(request: Request): Omit<RequestRow, "id"> {
  return {
    link_id: request.linkId,
    channel_id: request.channelId,
    root_ts: request.rootTs,
    source_ts: request.sourceTs,
    requester_user_id: request.requesterUserId,
    reason: request.reason,
    state: request.state,
    input_rev: request.inputRev,
    input_hash: request.inputHash,
    served_rev: request.servedRev,
    attention: request.attention,
    source_unverified_at: request.sourceUnverifiedAt,
    held_at: request.heldAt,
    hold_reason: request.holdReason,
    late: request.late ? 1 : 0,
    created_at: request.createdAt,
    changed_at: request.changedAt,
    seen_at: request.seenAt,
    touched_at: request.touchedAt,
    reminded_at: request.remindedAt,
    progress_ts: request.progressTs,
    expires_at: request.expiresAt,
    closed_reason: request.closedReason,
    closed_reported_at: request.closedReportedAt,
  };
}

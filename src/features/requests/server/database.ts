import {
  canMove,
  isActive,
  requestStates,
  type Request,
  type RequestAttention,
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
  attention: RequestAttention | null;
  created_at: number;
  changed_at: number;
  touched_at: number | null;
  expires_at: number;
  closed_reason: string | null;
};

const activeStates = requestStates.filter(isActive);
const expiringStates = requestStates.filter((state) => canMove(state, "expired"));

export async function readRequest(sql: Bun.SQL, id: number): Promise<StoredRequest | null> {
  const [row] = await sql<RequestRow[]>`SELECT * FROM requests WHERE id = ${id}`;
  return row ? requestFromRow(row) : null;
}

/**
 * The newest request a person has open or seen in a thread, which their later messages there join.
 * Once the lead answers, their next message asks anew.
 */
export async function readJoinableRequest(
  sql: Bun.SQL,
  linkId: string,
  requesterUserId: string,
  rootTs: SlackTs,
): Promise<StoredRequest | null> {
  const [row] = await sql<RequestRow[]>`
    SELECT * FROM requests
    WHERE link_id = ${linkId} AND requester_user_id = ${requesterUserId} AND root_ts = ${rootTs}
      AND state IN ('open', 'seen')
    ORDER BY id DESC LIMIT 1
  `;
  return row ? requestFromRow(row) : null;
}

/** A link's open, seen and answering requests, oldest first. */
export async function readActiveRequests(sql: Bun.SQL, linkId: string): Promise<StoredRequest[]> {
  const rows = await sql<RequestRow[]>`
    SELECT * FROM requests WHERE link_id = ${linkId} AND state IN ${sql(activeStates)} ORDER BY id
  `;
  return rows.map(requestFromRow);
}

/** Every link's requests still waiting on the lead whose lifetime ended by `now`, oldest first. */
export async function readOverdueRequests(sql: Bun.SQL, now: number): Promise<StoredRequest[]> {
  const rows = await sql<RequestRow[]>`
    SELECT * FROM requests
    WHERE state IN ${sql(expiringStates)} AND expires_at <= ${now} ORDER BY id
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

/** Whether anyone started a request in a link's thread, whatever became of it. */
export async function hasRequestInThread(
  sql: Bun.SQL,
  linkId: string,
  rootTs: SlackTs,
): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM requests WHERE link_id = ${linkId} AND root_ts = ${rootTs}`;
  return rows.length > 0;
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
    attention: row.attention,
    createdAt: row.created_at,
    changedAt: row.changed_at,
    touchedAt: row.touched_at,
    expiresAt: row.expires_at,
    closedReason: row.closed_reason,
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
    attention: request.attention,
    created_at: request.createdAt,
    changed_at: request.changedAt,
    touched_at: request.touchedAt,
    expires_at: request.expiresAt,
    closed_reason: request.closedReason,
  };
}

/** Deletes a link's requests, along with which messages each held. */
export async function deleteLinkRequests(transaction: Bun.SQL, linkId: string): Promise<void> {
  await transaction`DELETE FROM requests WHERE link_id = ${linkId}`;
}

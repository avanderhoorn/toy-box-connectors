import type { SlackTs } from "@slackapi/model/ts";

// The request lifecycle.
//
// The bridge owns request state, and every change goes through a function here, in the same
// transaction as whatever caused it. An edit or follow-up after the lead read a request flags it as
// updated, and the lead can't answer or dismiss it until inbox shows the change, so an answer to
// text the lead never read never posts. Once the lead answers, later edits change nothing. A
// request counts as answered only once Slack confirms its reply, and answered, dismissed, cancelled
// and expired requests never reopen. A new ask starts a new request.

export const requestStates = [
  "open",
  "seen",
  "answering",
  "answered",
  "dismissed",
  "cancelled",
  "expired",
] as const;

export type RequestState = (typeof requestStates)[number];

/** Why a request opened. */
export type RequestReason = "mention" | "follow_up" | "channel_root";

/** What the lead must read about a request it has seen before it can answer or dismiss it. */
export type RequestAttention = "updated" | "reply_failed";

/** Why a request was cancelled. */
export type CancelReason = "source_deleted" | "mention_removed" | "requester_denied";

const transitions: Record<RequestState, readonly RequestState[]> = {
  open: ["seen", "cancelled", "expired"],
  seen: ["answering", "dismissed", "cancelled", "expired"],
  // The reply is queued, sending or unconfirmed, so the request waits on the outbox.
  answering: ["answered", "seen", "cancelled"],
  answered: [],
  dismissed: [],
  cancelled: [],
  expired: [],
};

/** How long a request waits for an answer, and how old a message first seen can be and ask. */
export const requestLifetimeMs = 7 * 24 * 60 * 60_000;

/** A request as the bridge stores it. Times are milliseconds since the epoch. */
export type Request = {
  linkId: string;
  channelId: string;
  rootTs: SlackTs;
  /** The message that opened the request. */
  sourceTs: SlackTs;
  requesterUserId: string;
  reason: RequestReason;
  state: RequestState;
  attention: RequestAttention | null;
  createdAt: number;
  /** When the request last began waiting on the lead. Wakes and debounces read it. */
  changedAt: number;
  /** When the lead last read or acted on the request. */
  touchedAt: number | null;
  /** The lead's reason for a dismissal, or the cancel reason. */
  closedReason: string | null;
};

/** What opening a request needs from the message that started it. */
export type NewRequest = Pick<
  Request,
  "linkId" | "channelId" | "rootTs" | "sourceTs" | "requesterUserId" | "reason"
>;

/** Whether a request still waits on the lead or on its reply. */
export function isActive(state: RequestState): boolean {
  return transitions[state].length > 0;
}

/** Whether a request may move from one state to another. */
export function canMove(from: RequestState, to: RequestState): boolean {
  return transitions[from].includes(to);
}

export function openRequest(request: NewRequest, now: number): Request {
  return {
    ...request,
    state: "open",
    attention: null,
    createdAt: now,
    changedAt: now,
    touchedAt: null,
    closedReason: null,
  };
}

/**
 * Records that a message joined a request, or that one of its messages was edited or deleted. A
 * request the lead has seen is flagged as updated, unless a failed reply already waits for the
 * lead, and waits on the lead again. Once the lead answers, the change is ignored, and the request
 * comes back as it was.
 */
export function changeRequest<T extends Request>(request: T, now: number): T {
  switch (request.state) {
    case "open":
      return { ...request, changedAt: now };
    case "seen":
      return { ...request, attention: request.attention ?? "updated", changedAt: now };
    default:
      return request;
  }
}

/**
 * Records that inbox or thread showed the lead a request as it stands. An open request becomes
 * seen, and the read answers its attention.
 */
export function serveRequest<T extends Request>(request: T, now: number): T {
  const served = { ...request, touchedAt: now, attention: null };
  return request.state === "open" ? move(served, "seen") : served;
}

/** Moves a request the lead read as it stands to answering, once the outbox queues its reply. */
export function beginAnswer<T extends Request>(request: T, now: number): T {
  assertRead(request, "be answered");
  return move(request, "answering", { touchedAt: now });
}

/** Records that Slack confirmed the request's reply, which answers it. */
export function confirmAnswer<T extends Request>(request: T): T {
  return move(request, "answered", closing(null));
}

/** Gives an answering request back to the lead because Slack refused its reply. */
export function returnToSeen<T extends Request>(request: T, now: number): T {
  if (request.state !== "answering") refuse(request, "return to the lead");
  return move(request, "seen", { attention: "reply_failed", changedAt: now });
}

/** Closes a request the lead read as it stands and decided needs no answer. */
export function dismissRequest<T extends Request>(request: T, reason: string): T {
  assertRead(request, "be dismissed");
  return move(request, "dismissed", closing(reason));
}

/** Closes a request whose source, mention or requester went away. */
export function cancelRequest<T extends Request>(request: T, reason: CancelReason): T {
  return move(request, "cancelled", closing(reason));
}

/** Closes a request that waited its lifetime on the lead. One whose reply is on its way can't. */
export function expireRequest<T extends Request>(request: T): T {
  return move(request, "expired", closing(null));
}

/** A change a request's state doesn't allow, which the CLI tells the lead instead of failing. */
export class RequestStateError extends Error {}

/** Refuses a change to a request the lead hasn't read, or hasn't read since it last changed. */
function assertRead(request: Request, change: string): void {
  if (request.state !== "seen" || request.attention !== null) refuse(request, change);
}

function move<T extends Request>(request: T, to: RequestState, changes: Partial<Request> = {}): T {
  if (!canMove(request.state, to)) refuse(request, `become ${to}`);
  return { ...request, ...changes, state: to };
}

function refuse(request: Request, change: string): never {
  const unread = request.attention === null ? "" : ` with ${request.attention} unread`;
  throw new RequestStateError(`A request that's ${request.state}${unread} can't ${change}.`);
}

function closing(reason: string | null): Partial<Request> {
  return { closedReason: reason, attention: null };
}

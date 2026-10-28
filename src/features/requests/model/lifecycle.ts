import { compareTs, type SlackTs } from "@slackapi/model/ts";

// The request lifecycle.
//
// The bridge owns request state, and every change goes through a function here,
// in the same transaction as whatever caused it. A request counts as answered
// only once Slack confirms its final reply to the current revision, and
// answered, dismissed, cancelled and expired requests never reopen. A new ask
// starts a new request.

export const requestStates = [
  "open",
  "seen",
  "in_progress",
  "answering",
  "answered",
  "dismissed",
  "cancelled",
  "expired",
] as const;

export type RequestState = (typeof requestStates)[number];

/** Why a request opened. */
export type RequestReason = "mention" | "follow_up" | "channel_root";

/** What the lead must read about a request it has seen. Reading it clears it. */
export type RequestAttention = "updated" | "reply_failed";

/** Why a request was cancelled. */
export type CancelReason =
  | "source_deleted"
  | "mention_removed"
  | "requester_denied"
  | "link_removed"
  | "channel_deleted"
  | "thread_gone";

const transitions: Record<RequestState, readonly RequestState[]> = {
  open: ["seen", "cancelled", "expired"],
  seen: ["in_progress", "answering", "dismissed", "cancelled", "expired"],
  in_progress: ["answering", "dismissed", "cancelled", "expired"],
  // A final reply is queued, sending or unconfirmed, so the request waits on the outbox.
  answering: ["answered", "in_progress", "cancelled"],
  answered: [],
  dismissed: [],
  cancelled: [],
  expired: [],
};

/** How long a request waits for an answer, and how old a message can be when first seen and still ask. */
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
  /** Counts substantive changes to the request's messages, from 1. */
  inputRev: number;
  inputHash: string;
  /** The revision the lead last read. Display only: reply and dismiss check the revision they quote. */
  servedRev: number;
  attention: RequestAttention | null;
  /**
   * Set after an outage, or when Slack withdraws the source, until repair re-reads the source. It
   * holds the request's replies in the outbox, and it never wakes the lead.
   */
  sourceUnverifiedAt: number | null;
  /** While held, the lead gets no reminders. The request still expires. */
  heldAt: number | null;
  holdReason: string | null;
  /** Found by gap repair rather than live. */
  late: boolean;
  createdAt: number;
  /** When the request last changed in a way the lead hasn't acted on. Wakes and debounces read it. */
  changedAt: number;
  seenAt: number | null;
  /** When the lead last read or acted on the request. */
  touchedAt: number | null;
  remindedAt: number | null;
  progressTs: SlackTs | null;
  expiresAt: number;
  /** The lead's reason for a dismissal, or the cancel reason. */
  closedReason: string | null;
  /** When inbox told the lead a request it read was cancelled or expired, so it says so once. */
  closedReportedAt: number | null;
};

/** What opening a request needs from the message that started it. */
export type NewRequest = Pick<
  Request,
  | "linkId"
  | "channelId"
  | "rootTs"
  | "sourceTs"
  | "requesterUserId"
  | "reason"
  | "inputHash"
  | "late"
>;

/** One of a request's messages, as far as its input is concerned. */
export type RequestInput = { ts: SlackTs; deleted: boolean; contentHash: string | null };

/** Thrown when a request's state doesn't allow a change. */
export class RequestStateError extends Error {
  constructor(
    readonly state: RequestState,
    readonly change: string,
  ) {
    super(`A request that's ${state.replace("_", " ")} can't ${change}.`);
  }
}

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
    inputRev: 1,
    servedRev: 0,
    attention: null,
    sourceUnverifiedAt: null,
    heldAt: null,
    holdReason: null,
    createdAt: now,
    changedAt: now,
    seenAt: null,
    touchedAt: null,
    remindedAt: null,
    progressTs: null,
    expiresAt: now + requestLifetimeMs,
    closedReason: null,
    closedReportedAt: null,
  };
}

/**
 * The text the server hashes into a request's input hash: its messages that
 * still exist, in ts order, so a joined message, an edit or a delete changes it.
 */
export function inputSource(messages: readonly RequestInput[]): string {
  return JSON.stringify(
    messages
      .filter((message) => !message.deleted)
      .sort((left, right) => compareTs(left.ts, right.ts))
      .map((message) => [message.ts, message.contentHash]),
  );
}

/**
 * Records new input on an active request. A joined message or a substantive edit
 * bumps the revision, releases a hold, and flags a request the lead has seen as
 * updated, unless a failed reply already waits for the lead. The lead reads the
 * new revision along with it. Input that hashes the same changes nothing.
 */
export function reviseRequest<T extends Request>(request: T, inputHash: string, now: number): T {
  if (!isActive(request.state)) throw new RequestStateError(request.state, "be revised");
  if (inputHash === request.inputHash) return request;
  return {
    ...request,
    inputRev: request.inputRev + 1,
    inputHash,
    changedAt: now,
    heldAt: null,
    holdReason: null,
    attention: request.state === "open" ? null : (request.attention ?? "updated"),
  };
}

/**
 * Records that inbox or thread showed the lead a request at its current
 * revision. An open request becomes seen, and the read answers its attention.
 */
export function serveRequest<T extends Request>(request: T, now: number): T {
  const served = { ...request, servedRev: request.inputRev, touchedAt: now, attention: null };
  return request.state === "open" ? move(served, "seen", { seenAt: now }) : served;
}

/** Moves a seen request to in progress when the lead sends progress. More progress keeps it there. */
export function startProgress<T extends Request>(request: T, now: number): T {
  if (request.state === "in_progress") return { ...request, touchedAt: now };
  if (request.state !== "seen") throw new RequestStateError(request.state, "start progress");
  return move(request, "in_progress", { touchedAt: now });
}

/**
 * Moves a request to answering once the outbox queues the lead's final reply to
 * its current revision. A request already answering an older revision stays
 * answering. The hold ends, and so does the request's attention.
 */
export function beginAnswer<T extends Request>(request: T, now: number): T {
  const changes = { touchedAt: now, heldAt: null, holdReason: null, attention: null };
  if (request.state === "answering") return { ...request, ...changes };
  return move(request, "answering", changes);
}

/**
 * Records that Slack confirmed a final reply to revision `rev`. It answers the
 * request only when no input arrived since. Otherwise the request goes back to
 * the lead, flagged as updated.
 */
export function confirmAnswer<T extends Request>(request: T, rev: number, now: number): T {
  if (rev > request.inputRev) {
    throw new RangeError(`Revision ${rev} is newer than the request's ${request.inputRev}`);
  }
  if (rev < request.inputRev) return returnToProgress(request, "updated", now);
  return move(request, "answered", closing(null));
}

/** Sends an answering request back to the lead because its final reply is stale, failed or dropped. */
export function returnToProgress<T extends Request>(
  request: T,
  attention: "updated" | "reply_failed",
  now: number,
): T {
  if (request.state !== "answering") {
    throw new RequestStateError(request.state, "return to progress");
  }
  return move(request, "in_progress", { attention, changedAt: now });
}

/**
 * Holds an active request's replies until repair re-reads its source. A request already held keeps
 * the time it was first marked.
 */
export function markSourceUnverified<T extends Request>(request: T, now: number): T {
  if (!isActive(request.state)) throw new RequestStateError(request.state, "hold its replies");
  if (request.sourceUnverifiedAt !== null) return request;
  return { ...request, sourceUnverifiedAt: now };
}

/** Closes a request the lead decided needs no answer. */
export function dismissRequest<T extends Request>(request: T, reason: string): T {
  return move(request, "dismissed", closing(reason));
}

/** Closes a request whose source, requester, link or channel went away. */
export function cancelRequest<T extends Request>(request: T, reason: CancelReason): T {
  return move(request, "cancelled", closing(reason));
}

/** Whether a request has waited its lifetime without an answer. Answering requests never expire. */
export function isDueToExpire(request: Request, now: number): boolean {
  return canMove(request.state, "expired") && now >= request.expiresAt;
}

export function expireRequest<T extends Request>(request: T, now: number): T {
  if (now < request.expiresAt) {
    throw new RangeError(`The request expires at ${request.expiresAt}, not ${now}`);
  }
  return move(request, "expired", closing(null));
}

/**
 * Records that inbox told the lead a request it read was cancelled or expired, so it stops work on
 * it. A request the lead never read needs no word.
 */
export function reportEnding<T extends Request>(
  request: T,
  now: number,
): T & { state: "cancelled" | "expired" } {
  const { state } = request;
  if (state !== "cancelled" && state !== "expired") {
    throw new RequestStateError(state, "be reported as no longer needed");
  }
  if (request.seenAt === null) {
    throw new RequestStateError(state, "be reported to a lead that never read it");
  }
  return { ...request, state, closedReportedAt: now };
}

/** Stops reminders while the lead waits for the owner to decide. Holding again replaces the reason. */
export function holdRequest<T extends Request>(request: T, reason: string, now: number): T {
  if (request.state !== "seen" && request.state !== "in_progress") {
    throw new RequestStateError(request.state, "be held");
  }
  return { ...request, heldAt: now, holdReason: reason, touchedAt: now };
}

/** Ends a hold, once the owner speaks in Toy Box. */
export function releaseHold<T extends Request>(request: T): T {
  return { ...request, heldAt: null, holdReason: null };
}

function move<T extends Request>(request: T, to: RequestState, changes: Partial<Request>): T {
  if (!canMove(request.state, to)) {
    throw new RequestStateError(request.state, `become ${to.replace("_", " ")}`);
  }
  return { ...request, ...changes, state: to };
}

function closing(reason: string | null): Partial<Request> {
  return {
    closedReason: reason,
    attention: null,
    sourceUnverifiedAt: null,
    heldAt: null,
    holdReason: null,
  };
}

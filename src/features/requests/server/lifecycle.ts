import { settleRequestAnswer } from "@outbox/server/answers";
import { cancelQueuedRequestItems, queueReaction } from "@outbox/server/database";
import {
  cancelRequest,
  dismissRequest,
  expireRequest,
  isDueToExpire,
  markSourceUnverified,
  releaseHold,
  reviseRequest,
  type CancelReason,
} from "@requests/model/lifecycle";
import {
  readActiveRequests,
  readHeldRequests,
  readInputHash,
  readOverdueRequests,
  saveRequest,
  type StoredRequest,
} from "./database";

// The request lifecycle on stored requests.
//
// Each change applies a lifecycle function to what's stored and saves the result, along with
// anything else the change owes, in the caller's transaction. A revision then settles the
// request's answer, after its last save, since settling reads the request as stored.

/**
 * Revises an active request from its messages as the ledger holds them now, so a final reply to an
 * older revision no longer answers it. Returns whether its input changed.
 */
export async function reviseStoredRequest(
  transaction: Bun.SQL,
  request: StoredRequest,
  now: number,
): Promise<boolean> {
  const revised = reviseRequest(request, await readInputHash(transaction, request.id), now);
  if (revised === request) return false;
  await saveRequest(transaction, revised);
  await settleRequestAnswer(transaction, request.id, now);
  return true;
}

/**
 * Holds a request's replies because Slack withdrew its source, and revises it from what the ledger
 * holds, which no longer counts the source. Returns whether it changed.
 */
export async function withdrawStoredSource(
  transaction: Bun.SQL,
  request: StoredRequest,
  now: number,
): Promise<boolean> {
  const held = markSourceUnverified(request, now);
  const revised = reviseRequest(held, await readInputHash(transaction, request.id), now);
  if (revised === request) return false;
  await saveRequest(transaction, revised);
  await settleRequestAnswer(transaction, request.id, now);
  return true;
}

/** Cancels a request along with its replies and progress notes that are still queued. */
export async function cancelStoredRequest(
  transaction: Bun.SQL,
  request: StoredRequest,
  reason: CancelReason,
  now: number,
): Promise<void> {
  await saveRequest(transaction, cancelRequest(request, reason));
  await cancelQueuedRequestItems(transaction, request.id, now);
}

/**
 * Holds the replies of every active request of a link until repair re-reads its source and thread,
 * because the bridge may have missed an edit, deletion or follow-up. A request that's held already
 * keeps when it was first held.
 */
export async function markLinkSourcesUnverified(
  transaction: Bun.SQL,
  linkId: string,
  now: number,
): Promise<void> {
  for (const request of await readActiveRequests(transaction, linkId)) {
    const marked = markSourceUnverified(request, now);
    if (marked !== request) await saveRequest(transaction, marked);
  }
}

/**
 * Dismisses a request the lead decided needs no answer, along with its replies and progress notes
 * that are still queued, and takes back the 👀 that told the requester the lead was coming.
 */
export async function dismissStoredRequest(
  transaction: Bun.SQL,
  request: StoredRequest,
  reason: string,
  now: number,
): Promise<void> {
  await saveRequest(transaction, dismissRequest(request, reason));
  await cancelQueuedRequestItems(transaction, request.id, now);
  await queueReaction(
    transaction,
    {
      action: "remove",
      name: "eyes",
      channelId: request.channelId,
      ts: request.sourceTs,
      linkId: request.linkId,
      requestId: request.id,
    },
    now,
  );
}

/** Cancels every active request of a link. Returns whether there were any. */
export async function cancelLinkRequests(
  transaction: Bun.SQL,
  linkId: string,
  reason: CancelReason,
  now: number,
): Promise<boolean> {
  const requests = await readActiveRequests(transaction, linkId);
  for (const request of requests) await cancelStoredRequest(transaction, request, reason, now);
  return requests.length > 0;
}

/**
 * Releases the holds a link's requests took before the owner last spoke in Toy Box. Returns
 * whether there were any.
 */
export async function releaseHolds(
  transaction: Bun.SQL,
  linkId: string,
  ownerSpokeAt: number,
): Promise<boolean> {
  const held = await readHeldRequests(transaction, linkId, ownerSpokeAt);
  for (const request of held) await saveRequest(transaction, releaseHold(request));
  return held.length > 0;
}

/**
 * Expires every request that waited its lifetime without an answer, along with its queued
 * progress notes. Returns whether there were any.
 */
export async function expireRequests(transaction: Bun.SQL, now: number): Promise<boolean> {
  const due = (await readOverdueRequests(transaction, now)).filter((request) =>
    isDueToExpire(request, now),
  );
  for (const request of due) {
    await saveRequest(transaction, expireRequest(request, now));
    await cancelQueuedRequestItems(transaction, request.id, now);
  }
  return due.length > 0;
}

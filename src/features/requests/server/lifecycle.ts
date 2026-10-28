import { cancelQueuedRequestItems } from "@outbox/server/database";
import {
  cancelRequest,
  expireRequest,
  isDueToExpire,
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
// anything else the change owes, in the caller's transaction.

/**
 * Revises an active request from its messages as the ledger holds them now. Returns whether its
 * input changed.
 */
export async function reviseStoredRequest(
  transaction: Bun.SQL,
  request: StoredRequest,
  now: number,
): Promise<boolean> {
  const revised = reviseRequest(request, await readInputHash(transaction, request.id), now);
  if (revised === request) return false;
  await saveRequest(transaction, revised);
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

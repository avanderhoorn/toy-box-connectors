import {
  cancelRequest,
  changeRequest,
  expireRequest,
  type CancelReason,
} from "@requests/model/lifecycle";
import { readOverdueRequests, saveRequest, type StoredRequest } from "./database";

// The request lifecycle on stored requests.
//
// Each change applies a lifecycle function to what's stored and saves the result in the caller's
// transaction.

/** Records that one of an active request's messages changed. Returns whether the request did. */
export async function changeStoredRequest(
  transaction: Bun.SQL,
  request: StoredRequest,
  now: number,
): Promise<boolean> {
  const changed = changeRequest(request, now);
  if (changed === request) return false;
  await saveRequest(transaction, changed);
  return true;
}

/** Cancels a request. A reply still queued for it fails when the outbox rechecks it at send time. */
export async function cancelStoredRequest(
  transaction: Bun.SQL,
  request: StoredRequest,
  reason: CancelReason,
): Promise<void> {
  await saveRequest(transaction, cancelRequest(request, reason));
}

/**
 * Expires every request that waited its lifetime without an answer. Returns whether there were
 * any. Only a request waiting on the lead expires, so none has a reply queued.
 */
export async function expireRequests(transaction: Bun.SQL, now: number): Promise<boolean> {
  const due = await readOverdueRequests(transaction, now);
  for (const request of due) await saveRequest(transaction, expireRequest(request));
  return due.length > 0;
}

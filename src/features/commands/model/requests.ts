// What the lead's request commands share.
//
// The lead names a request the way inbox shows it, such as r14, and acts only on one it has read
// that still waits on its answer. Each command refuses any other before it changes anything, and
// says why in words the lead can act on. Dismiss quotes the revision the lead read, so it never
// closes a request over text that changed since.

import { z } from "zod";
import { requestLifetimeMs, type CancelReason, type Request } from "@requests/model/lifecycle";
import type { Refusal } from "./protocol";

export const requestIdSchema = z
  .number()
  .int()
  .positive()
  .describe("The request's number, shown as r14");

/** A request as the lead writes it, such as r14, which the bridge reads as its number. */
export const requestReferenceSchema = z
  .string()
  .regex(/^r[1-9][0-9]{0,14}$/, "Write it as inbox shows it, such as r14")
  .transform((reference) => Number(reference.slice(1)))
  .describe("The request, such as r14");

export const revisionSchema = z
  .number()
  .int()
  .positive()
  .describe("The revision you read, which inbox and thread show");

/** The most a reason may say, since it records why rather than the work. */
export const REASON_LIMIT = 200;

/** Why the lead acted, kept with the request for whoever looks into it later. */
export const reasonSchema = z
  .string()
  .trim()
  .min(1, "Can't be blank")
  .max(REASON_LIMIT, `Keep it within ${REASON_LIMIT} characters`);

/**
 * Why the lead can't hold or dismiss a request in its state, or null when it can: the lead read it
 * and it waits on the lead's answer.
 */
export function requestStateProblem(
  request: Pick<Request, "state" | "closedReason"> & { id: number },
): Refusal | null {
  const name = `r${request.id}`;
  switch (request.state) {
    case "seen":
    case "in_progress":
      return null;
    case "open":
      return {
        rule: "unread_request",
        message: `You haven't read ${name} yet. Run \`toy-box-slack thread ${name}\` to read it.`,
      };
    case "answering":
      return {
        rule: "answering_request",
        message: `Your reply to ${name} is on its way to Slack. If it doesn't post, the next inbox shows ${name} again.`,
      };
    case "answered":
    case "dismissed":
      return { rule: "closed_request", message: `${name} was already ${request.state}.` };
    case "cancelled":
    case "expired": {
      const { clause, caution } = requestEnding({ ...request, state: request.state });
      const ended = request.state === "cancelled" ? `was ${clause}` : clause;
      return {
        rule: "closed_request",
        message: [`${name} ${ended}.`, ...(caution ? [caution] : [])].join(" "),
      };
    }
  }
}

/**
 * Why `revision` isn't the request's current one, or null when it is. The lead quotes the revision
 * it read, so it never acts on text that changed since, even when a later read showed the change.
 */
export function revisionProblem(
  request: Pick<Request, "inputRev"> & { id: number },
  revision: number,
): Refusal | null {
  const name = `r${request.id}`;
  const read = `\`toy-box-slack thread ${name}\``;
  if (revision < request.inputRev) {
    return {
      rule: "stale_revision",
      message: `${name} changed since you read revision ${revision}. Run ${read} to read revision ${request.inputRev}.`,
    };
  }
  if (revision > request.inputRev) {
    return {
      rule: "unknown_revision",
      message: `${name} has no revision ${revision}. Its latest is revision ${request.inputRev}, which ${read} shows.`,
    };
  }
  return null;
}

/** How a request ended without an answer, which the lead hears in words and never in its text. */
export type RequestEnding = {
  /** Reads after the request's name, as in "cancelled because the message was deleted in Slack". */
  clause: string;
  /** A sentence to add when what the request said must not travel further. */
  caution: string | null;
};

const cancelReasons: Record<CancelReason, string> = {
  source_deleted: "the message was deleted in Slack",
  mention_removed: "the message no longer mentions you",
  requester_denied: "the person who asked is no longer allowed",
  link_removed: "this channel was unlinked from Slack",
  channel_deleted: "its Slack channel was deleted",
  thread_gone: "Slack could not deliver to its thread",
};

const DAY = 24 * 60 * 60_000;

/** Why a cancelled or expired request ended. */
export function requestEnding({
  state,
  closedReason,
}: Pick<Request, "closedReason"> & { state: "cancelled" | "expired" }): RequestEnding {
  if (state === "expired") {
    const days = Math.round(requestLifetimeMs / DAY);
    return { clause: `expired after ${days} days without an answer`, caution: null };
  }
  if (closedReason === null || !Object.hasOwn(cancelReasons, closedReason)) {
    return { clause: "cancelled", caution: null };
  }
  return {
    clause: `cancelled because ${cancelReasons[closedReason as CancelReason]}`,
    caution: closedReason === "source_deleted" ? "Don't repeat what it said." : null,
  };
}

import type { StoredVersion } from "@activity/server/ledger";
import { classify, type ClassifyLink } from "@requests/model/classify";
import { isActive, openRequest } from "@requests/model/lifecycle";
import type { SlackMessage } from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";
import {
  assignRequestMessage,
  insertRequest,
  readMessageRequest,
  readThreadRequests,
} from "./database";
import { cancelStoredRequest, changeStoredRequest } from "./lifecycle";

// Request intake.
//
// Request policy runs over each version of a message the ledger stores, in the same transaction.
// A new message is classified. An edit changes the request its message belongs to, or cancels the
// request whose mention it removed, and asks again only when it adds a mention to a message no
// active request has. Once the lead answers, edits change nothing. Deleting a request's source
// cancels the request, and deleting one of its other messages changes it.

/** The link settings intake reads. */
export type IntakeLink = ClassifyLink & { id: string };

/**
 * Applies request policy to a version of a message the ledger just stored. Returns whether a
 * request changed.
 */
export async function takeMessage(
  transaction: Bun.SQL,
  link: IntakeLink,
  message: SlackMessage,
  stored: StoredVersion,
  now: number,
): Promise<boolean> {
  const { decision } = stored;
  // A redelivery, a fill-in and a version that says the same thing ask nothing new.
  if (decision.kind === "ignore" || decision.change === null) return false;
  const { channelId, ts } = message;

  const current = await readMessageRequest(transaction, channelId, ts);
  if (current !== null && isActive(current.state)) {
    if (current.state === "answering") return false;
    if (current.reason === "mention" && current.sourceTs === ts && !message.mentionsBot) {
      await cancelStoredRequest(transaction, current, "mention_removed", now);
      return true;
    }
    return changeStoredRequest(transaction, current, now);
  }
  // A finished request never reopens, so its message asks again only by gaining a mention.
  if (current !== null && !(message.mentionsBot && !stored.mentionedBot)) return false;

  const requester = message.userId;
  if (requester === null) return false;
  const asked = await readThreadRequests(transaction, link.id, requester, message.rootTs);
  // Their later messages join the newest request still waiting on the lead.
  const active = asked.findLast(({ state }) => state === "open" || state === "seen") ?? null;
  const classification = classify(message, {
    link,
    role: stored.role,
    active,
    askedBefore: asked.some((request) => compareTs(request.sourceTs, ts) < 0),
    firstSight: decision.kind === "insert",
    now,
  });
  switch (classification.kind) {
    case "none":
      return false;
    case "join":
      await assignRequestMessage(transaction, active!.id, channelId, ts);
      return changeStoredRequest(transaction, active!, now);
    case "request": {
      const request = await insertRequest(
        transaction,
        openRequest(
          {
            linkId: link.id,
            channelId,
            rootTs: message.rootTs,
            sourceTs: ts,
            requesterUserId: requester,
            reason: classification.reason,
          },
          now,
        ),
      );
      await assignRequestMessage(transaction, request.id, channelId, ts);
      return true;
    }
  }
}

/** Applies request policy to a delete the ledger just stored. Returns whether a request changed. */
export async function takeDelete(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
  now: number,
): Promise<boolean> {
  const request = await readMessageRequest(transaction, channelId, ts);
  if (request === null || !isActive(request.state)) return false;
  if (request.sourceTs === ts) {
    await cancelStoredRequest(transaction, request, "source_deleted", now);
    return true;
  }
  return changeStoredRequest(transaction, request, now);
}

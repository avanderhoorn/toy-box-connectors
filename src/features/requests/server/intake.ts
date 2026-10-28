import type { StoredVersion } from "@activity/server/ledger";
import { classify, type ClassifyLink } from "@requests/model/classify";
import { isActive, openRequest } from "@requests/model/lifecycle";
import type { SlackMessage } from "@slackapi/model/messages";
import type { SlackTs } from "@slackapi/model/ts";
import {
  askedBefore,
  assignRequestMessage,
  hashInput,
  insertRequest,
  readActiveRequest,
  readMessageRequest,
} from "./database";
import { cancelStoredRequest, reviseStoredRequest } from "./lifecycle";

// Request intake.
//
// Request policy runs over each version of a message the ledger stores, in the same transaction.
// A new message is classified. An edit revises the active request its message belongs to, or
// cancels the request whose mention it removed, and asks again only when it adds a mention to a
// message no active request has. Deleting a request's source cancels the request, and deleting
// one of its other messages revises it.

/** The link settings intake reads. */
export type IntakeLink = ClassifyLink & { id: string };

/** What intake did to a link's requests. */
export type Intake = {
  /** Whether a request opened, changed or closed. */
  changed: boolean;
  /** Whether the message opened a request, whose thread the ledger must then track. */
  opened: boolean;
};

const unchanged: Intake = { changed: false, opened: false };

/** Applies request policy to a version of a message the ledger just stored. */
export async function takeMessage(
  transaction: Bun.SQL,
  link: IntakeLink,
  message: SlackMessage,
  stored: StoredVersion,
  options: { late: boolean; now: number },
): Promise<Intake> {
  const { decision } = stored;
  // A redelivery, a fill-in and a version that says the same thing ask nothing new.
  if (decision.kind === "ignore" || decision.change === null) return unchanged;
  const { channelId, ts } = message;
  const { now } = options;

  const current = await readMessageRequest(transaction, channelId, ts);
  if (current !== null && isActive(current.state)) {
    if (current.reason === "mention" && current.sourceTs === ts && !message.mentionsBot) {
      await cancelStoredRequest(transaction, current, "mention_removed", now);
      return { changed: true, opened: false };
    }
    return { changed: await reviseStoredRequest(transaction, current, now), opened: false };
  }
  // A finished request never reopens, so its message asks again only by gaining a mention.
  if (current !== null && !(message.mentionsBot && !stored.mentionedBot)) return unchanged;

  const requester = message.userId;
  if (requester === null) return unchanged;
  const active = await readActiveRequest(transaction, link.id, requester, message.rootTs);
  const classification = classify(message, {
    link,
    role: stored.role,
    active,
    askedBefore: await askedBefore(transaction, link.id, requester, message.rootTs, ts),
    firstSight: decision.kind === "insert",
    now,
  });
  switch (classification.kind) {
    case "none":
      return unchanged;
    case "join":
      await assignRequestMessage(transaction, active!.id, channelId, ts);
      await reviseStoredRequest(transaction, active!, now);
      return { changed: true, opened: false };
    case "request": {
      const inputHash = hashInput([{ ts, deleted: false, contentHash: stored.contentHash }]);
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
            inputHash,
            late: options.late,
          },
          now,
        ),
      );
      await assignRequestMessage(transaction, request.id, channelId, ts);
      return { changed: true, opened: true };
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
  return reviseStoredRequest(transaction, request, now);
}

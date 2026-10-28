import type { AuthorRole } from "@activity/model/ledger";
import type { SlackMessage } from "@slackapi/model/messages";
import { compareTs, tsAt, type SlackTs } from "@slackapi/model/ts";
import { isCourtesyOnly } from "./courtesy";
import { requestLifetimeMs, type RequestReason } from "./lifecycle";

// Classification.
//
// Pure policy over a stored message, run in the same transaction that stores
// it, so a request exists exactly when its message does. Rules apply in order
// and the first match wins. Bridge code decides who may ask. The model is never
// asked.
//
// Catch-up can store a message after later ones from the same thread, so the
// rules about a requester's history only look backward from the message's own
// ts. That way a late find classifies as it would have live.

export type NoneReason =
  | "link_inactive"
  | "not_a_person"
  | "before_link"
  | "too_old"
  | "not_allowlisted"
  | "courtesy"
  | "addressed_to_others"
  | "before_request"
  | "context_only";

export type Classification =
  | { kind: "none"; reason: NoneReason }
  | { kind: "join"; requestId: number }
  | { kind: "request"; reason: RequestReason };

/** The link settings classification reads. */
export type ClassifyLink = {
  status: "active" | "paused" | "suspended";
  requestMode: "mention" | "all";
  linkedAtTs: SlackTs;
};

/** What the ledger knows about a message, its author and their requests in its thread. */
export type ClassifyFacts = {
  link: ClassifyLink;
  role: AuthorRole;
  /** The author's newest open or seen request in the thread. */
  active: { id: number; sourceTs: SlackTs } | null;
  /** Whether the author started a request in the thread, in any state, before this message. */
  askedBefore: boolean;
  /** False when the message is an edit of one the ledger already stored. */
  firstSight: boolean;
  now: number;
};

export function classify(message: SlackMessage, facts: ClassifyFacts): Classification {
  const { link } = facts;
  if (message.author !== "person") return none("not_a_person");
  if (compareTs(message.ts, link.linkedAtTs) <= 0) return none("before_link");
  if (facts.firstSight && compareTs(message.ts, tsAt(facts.now - requestLifetimeMs)) < 0) {
    return none("too_old");
  }
  if (facts.role !== "allowed") return none("not_allowlisted");
  if (isCourtesyOnly(message)) return none("courtesy");
  if (message.mentions.length > 0 && !message.mentionsBot) return none("addressed_to_others");

  // A paused link still lets a requester add to what they asked, so the lead reads it before
  // answering once the link resumes, but nothing new asks.
  if (facts.active !== null) {
    return compareTs(message.ts, facts.active.sourceTs) > 0
      ? { kind: "join", requestId: facts.active.id }
      : none("before_request");
  }
  if (link.status !== "active") return none("link_inactive");
  if (message.mentionsBot) return { kind: "request", reason: "mention" };
  if (message.isReply && facts.askedBefore) return { kind: "request", reason: "follow_up" };
  if (link.requestMode === "all" && !message.isReply) {
    return { kind: "request", reason: "channel_root" };
  }
  return none("context_only");
}

function none(reason: NoneReason): Classification {
  return { kind: "none", reason };
}

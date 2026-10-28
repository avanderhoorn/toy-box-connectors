import type { SlackMessage } from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";

// The ledger keeps one row per channel and ts. Live events and gap repair merge
// through the same decision, so replaying an envelope or a history page
// converges to the same rows and appends no change.

/** The author's standing in a link, fixed when a message is stored. */
export type AuthorRole =
  /** The installation's owner, who is always allowed. */
  | "owner"
  /** A person on the link's allowlist. */
  | "allowed"
  /** Any other person. */
  | "observed"
  /** Our bot. */
  | "self"
  /** Another bot, an app, Slackbot or a notice. Never kept. */
  | "other";

/**
 * What a link says about the people in its channel. People are matched by exact user ID, never by
 * the workspace a message names for its author.
 */
export type LinkAudience = {
  ownerUserId: string | null;
  allowlist: ReadonlySet<string>;
  observe: "requesters" | "channel";
};

export function authorRole(message: SlackMessage, audience: LinkAudience): AuthorRole {
  switch (message.author) {
    case "self":
      return "self";
    case "bot":
    case "notice":
      return "other";
    case "person": {
      if (message.userId === null) return "observed";
      if (message.userId === audience.ownerUserId) return "owner";
      return audience.allowlist.has(message.userId) ? "allowed" : "observed";
    }
  }
}

/**
 * Whether the ledger keeps a message's text and files or only a content-free
 * marker. Requesters mode keeps an observed person's text only inside a request
 * thread, and no mode keeps another bot's.
 */
export function keepsText(
  role: AuthorRole,
  observe: LinkAudience["observe"],
  inRequestThread: boolean,
): boolean {
  switch (role) {
    case "other":
      return false;
    case "owner":
    case "allowed":
    case "self":
      return true;
    case "observed":
      return observe === "channel" || inRequestThread;
  }
}

/**
 * The exact text, files and mentions that make a message's content, for the
 * server to hash. Unfurls and reply counts aren't in it, so they never count as
 * edits.
 */
export function fingerprintSource(message: SlackMessage): string {
  const fileIds = message.files.map((file) => file.id).sort();
  return JSON.stringify([message.text, fileIds, message.mentions]);
}

/**
 * What the ledger holds for a message. A marker or a tombstone has no content hash, and a withdrawn
 * message is a tombstone its author didn't ask for.
 */
export type StoredMessage = {
  version: SlackTs;
  deleted: boolean;
  withdrawn: boolean;
  contentHash: string | null;
};

/** A version of a message to merge. `contentHash` is null when the ledger keeps only a marker. */
export type IncomingMessage = { version: SlackTs; contentHash: string | null };

/** How a merge changes the ledger. `change` is the change record it appends, if any. */
export type MergeDecision =
  | { kind: "insert"; change: "new" | "deleted" | "withdrawn" }
  | { kind: "update"; change: "edited" | "deleted" | "withdrawn" | null }
  | { kind: "ignore"; reason: "duplicate" | "older" | "tombstoned" };

/**
 * Merges a delete into what's stored. A delete always wins and is never undone, and it turns a
 * withdrawn message into a deleted one, since only its author or an admin deletes.
 */
export function mergeDelete(stored: StoredMessage | null): MergeDecision {
  if (stored === null) return { kind: "insert", change: "deleted" };
  if (stored.deleted && !stored.withdrawn) return { kind: "ignore", reason: "duplicate" };
  return { kind: "update", change: "deleted" };
}

/**
 * Merges Slack withdrawing a message's content into what's stored. Like a delete it always wins,
 * whatever version it carries, so neither our copy nor a late original ever brings the content
 * back, and it leaves a deleted message deleted.
 */
export function mergeWithdrawal(stored: StoredMessage | null): MergeDecision {
  if (stored === null) return { kind: "insert", change: "withdrawn" };
  if (stored.withdrawn) return { kind: "ignore", reason: "duplicate" };
  if (stored.deleted) return { kind: "ignore", reason: "tombstoned" };
  return { kind: "update", change: "withdrawn" };
}

/**
 * Merges a version of a message into what's stored. The newest version wins, and
 * a tombstone always does, so a late original never brings a deleted or withdrawn
 * message back. Keeping text or dropping it to a marker is an edit. A redelivery that now
 * keeps a marker's text fills it in without a change, which is how a thread's
 * earlier messages fill in once a request starts there.
 */
export function mergeSnapshot(
  stored: StoredMessage | null,
  incoming: IncomingMessage,
): MergeDecision {
  if (stored === null) return { kind: "insert", change: "new" };
  if (stored.deleted) return { kind: "ignore", reason: "tombstoned" };

  const order = compareTs(incoming.version, stored.version);
  if (order < 0) return { kind: "ignore", reason: "older" };
  if (order === 0) {
    return incoming.contentHash !== null && stored.contentHash === null
      ? { kind: "update", change: null }
      : { kind: "ignore", reason: "duplicate" };
  }
  return { kind: "update", change: incoming.contentHash !== stored.contentHash ? "edited" : null };
}

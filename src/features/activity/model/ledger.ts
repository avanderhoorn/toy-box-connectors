import type { SlackMessage } from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";

// The ledger keeps one row per channel and ts. Live events and catch-up merge
// through the same decision, so replaying an envelope or a history page
// converges to the same rows and appends no change.

/**
 * How long the bridge keeps what was said: a message after its latest version, and a post after it
 * last changed.
 */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

/** The author's standing in a link, fixed when a message is stored. */
export type AuthorRole =
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
      return audience.allowlist.has(message.userId) ? "allowed" : "observed";
    }
  }
}

/**
 * Whether the ledger keeps a message's text or only a content-free marker.
 * Requesters mode keeps an observed person's text only inside a request thread,
 * and no mode keeps another bot's.
 */
export function keepsText(
  role: AuthorRole,
  observe: LinkAudience["observe"],
  inRequestThread: boolean,
): boolean {
  switch (role) {
    case "other":
      return false;
    case "allowed":
    case "self":
      return true;
    case "observed":
      return observe === "channel" || inRequestThread;
  }
}

/**
 * The exact text, mentions and shared files that make a message's content, for the server to hash.
 * Attachments, unfurls and reply counts aren't in it, so they never count as edits. A message that
 * shares no files hashes as it did before the ledger kept files, so updating edits nothing.
 */
export function fingerprintSource(message: SlackMessage): string {
  if (message.files.length === 0) return JSON.stringify([message.text, message.mentions]);
  const fileIds = message.files.map((file) => file.id).toSorted();
  return JSON.stringify([message.text, message.mentions, fileIds]);
}

/** What the ledger holds for a message. A marker or a tombstone has no content hash. */
export type StoredMessage = { version: SlackTs; deleted: boolean; contentHash: string | null };

/** A version of a message to merge. `contentHash` is null when the ledger keeps only a marker. */
export type IncomingMessage = { version: SlackTs; contentHash: string | null };

/** How a merge changes the ledger. `change` is the change record it appends, if any. */
export type MergeDecision =
  | { kind: "insert"; change: "new" | "deleted" }
  | { kind: "update"; change: "edited" | "deleted" | null }
  | { kind: "ignore"; reason: "duplicate" | "older" | "tombstoned" };

/**
 * Merges a delete into what's stored. A delete always wins and is never undone. Slack withdrawing
 * a message's content merges the same way, since the bridge may no longer keep it.
 */
export function mergeDelete(stored: StoredMessage | null): MergeDecision {
  if (stored === null) return { kind: "insert", change: "deleted" };
  if (stored.deleted) return { kind: "ignore", reason: "duplicate" };
  return { kind: "update", change: "deleted" };
}

/**
 * Merges a version of a message into what's stored. The newest version wins, and
 * a tombstone always does, so a late original never brings a deleted message
 * back. Keeping text or dropping it to a marker is an edit. A redelivery that now
 * keeps a marker's text, such as an earlier message in a thread where a request
 * started since, fills it in without a change.
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

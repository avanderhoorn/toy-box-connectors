import {
  authorRole,
  fingerprintSource,
  keepsText,
  mergeDelete,
  mergeSnapshot,
  RETENTION_MS,
  type AuthorRole,
  type LinkAudience,
  type MergeDecision,
  type StoredMessage,
} from "@activity/model/ledger";
import type { SlackMessage } from "@slackapi/model/messages";
import type { SlackTs } from "@slackapi/model/ts";

// The ledger's writes.
//
// Live events and catch-up store messages through these functions, in the transaction that records
// what they read, so replaying an envelope or a history page converges to the same rows. A merge
// that changes what a message says appends a change, and the row keeps that change's seq.

/** What storing one version of a message did. */
export type StoredVersion = {
  decision: MergeDecision;
  role: AuthorRole;
  /** Whether the version stored before this one mentioned the bot. */
  mentionedBot: boolean;
};

type Applied = Exclude<MergeDecision, { kind: "ignore" }>;

type MessageRow = {
  version: SlackTs;
  deleted: number;
  content_hash: string | null;
  mentions_bot: number;
};

/**
 * Merges a version of a message into the ledger, whether it arrived live or from history.
 * `inRequestThread` says whether a request started in its thread, so its text is kept whoever
 * wrote it.
 */
export async function storeMessage(
  transaction: Bun.SQL,
  audience: LinkAudience,
  message: SlackMessage,
  inRequestThread: boolean,
): Promise<StoredVersion> {
  const { channelId, ts } = message;
  const role = authorRole(message, audience);
  const kept = keepsText(role, audience.observe, inRequestThread);
  const contentHash = kept ? Bun.SHA256.hash(fingerprintSource(message), "hex") : null;
  const row = await readMessage(transaction, channelId, ts);
  const decision = mergeSnapshot(storedMessage(row), { version: message.version, contentHash });
  if (decision.kind !== "ignore") {
    await writeMessage(transaction, channelId, ts, decision, {
      thread_ts: message.threadTs,
      user_id: message.userId,
      author_role: role,
      text: kept ? message.text : null,
      content_hash: contentHash,
      mentions_bot: kept && message.mentionsBot ? 1 : 0,
      edited_ts: message.editedTs,
      version: message.version,
    });
  }
  return { decision, role, mentionedBot: row?.mentions_bot === 1 };
}

/**
 * Merges a delete into the ledger, forgetting the message's text. A message the ledger never saw
 * leaves a tombstone, so its late original stays deleted.
 */
export async function storeDelete(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
): Promise<MergeDecision> {
  const decision = mergeDelete(storedMessage(await readMessage(transaction, channelId, ts)));
  if (decision.kind === "ignore") return decision;
  await writeMessage(
    transaction,
    channelId,
    ts,
    decision,
    decision.kind === "insert"
      ? { author_role: "other", deleted: 1, version: ts }
      : { deleted: 1, text: null, content_hash: null, mentions_bot: 0 },
  );
  return decision;
}

/**
 * Forgets every message last changed longer ago than the ledger keeps one, a tombstone too, since
 * Slack never shows a deleted message again. Changes keep no text, so they stay.
 */
export async function forgetOldMessages(transaction: Bun.SQL, now: number): Promise<void> {
  // SQLite casts a ts to its whole seconds.
  const before = Math.floor((now - RETENTION_MS) / 1000);
  await transaction`DELETE FROM messages WHERE CAST(version AS INTEGER) < ${before}`;
}

async function readMessage(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
): Promise<MessageRow | null> {
  const [row] = await transaction<MessageRow[]>`
    SELECT version, deleted, content_hash, mentions_bot
    FROM messages WHERE channel_id = ${channelId} AND ts = ${ts}
  `;
  return row ?? null;
}

function storedMessage(row: MessageRow | null): StoredMessage | null {
  return row && { version: row.version, deleted: row.deleted === 1, contentHash: row.content_hash };
}

async function writeMessage(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
  decision: Applied,
  columns: Record<string, string | number | null>,
): Promise<void> {
  const row = { ...columns };
  if (decision.change !== null) {
    row.updated_seq = await appendChange(transaction, channelId, ts, decision.change);
  }
  if (decision.kind === "insert") {
    await transaction`INSERT INTO messages ${transaction({ channel_id: channelId, ts, ...row })}`;
  } else {
    await transaction`
      UPDATE messages SET ${transaction(row)} WHERE channel_id = ${channelId} AND ts = ${ts}
    `;
  }
}

async function appendChange(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
  kind: NonNullable<Applied["change"]>,
): Promise<number> {
  const [change] = await transaction<{ seq: number }[]>`
    INSERT INTO changes (channel_id, ts, kind)
    VALUES (${channelId}, ${ts}, ${kind})
    RETURNING seq
  `;
  return change!.seq;
}

/** Deletes the messages and changes the ledger kept from a link's channel. */
export async function deleteLinkActivity(
  transaction: Bun.SQL,
  link: { slackChannelId: string },
): Promise<void> {
  await transaction`DELETE FROM changes WHERE channel_id = ${link.slackChannelId}`;
  await transaction`DELETE FROM messages WHERE channel_id = ${link.slackChannelId}`;
}

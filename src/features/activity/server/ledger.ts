import {
  authorRole,
  fingerprintSource,
  keepsText,
  mergeDelete,
  mergeSnapshot,
  type AuthorRole,
  type LinkAudience,
  type MergeDecision,
  type StoredMessage,
} from "@activity/model/ledger";
import type { SlackMessage } from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";
import { forgetMessageFiles, syncMessageFiles } from "./files";

// The ledger's writes.
//
// Live events and gap repair store messages through these functions, in the transaction that
// records what they read, so replaying an envelope or a history page converges to the same rows.
// A merge that changes what a message says appends a change, and the row keeps that change's seq.

/** The link a message's channel belongs to. */
export type LedgerLink = { id: string; audience: LinkAudience };

/** What storing one version of a message did. */
export type StoredVersion = {
  decision: MergeDecision;
  role: AuthorRole;
  /** Null when the ledger keeps only a marker. */
  contentHash: string | null;
  /** Whether the version stored before this one mentioned the bot. */
  mentionedBot: boolean;
  /** Local copies of files the message no longer has, to remove once the transaction commits. */
  purged: string[];
};

/** What storing a delete did. */
export type StoredDelete = { decision: MergeDecision; purged: string[] };

type Applied = Exclude<MergeDecision, { kind: "ignore" }>;

type MessageRow = {
  version: SlackTs;
  deleted: number;
  content_hash: string | null;
  mentions_bot: number;
};

/** Merges a version of a message into the ledger, whether it arrived live or from history. */
export async function storeMessage(
  transaction: Bun.SQL,
  link: LedgerLink,
  message: SlackMessage,
): Promise<StoredVersion> {
  const { channelId, ts } = message;
  const role = authorRole(message, link.audience);
  const inRequestThread = await isTracked(transaction, channelId, message.rootTs);
  const kept = keepsText(role, link.audience.observe, inRequestThread);
  const contentHash = kept ? Bun.SHA256.hash(fingerprintSource(message), "hex") : null;
  const row = await readMessage(transaction, channelId, ts);
  const decision = mergeSnapshot(storedMessage(row), { version: message.version, contentHash });

  let purged: string[] = [];
  if (decision.kind !== "ignore") {
    await writeMessage(transaction, link.id, channelId, ts, decision, {
      thread_ts: message.threadTs,
      user_id: message.userId,
      team_id: message.teamId,
      subtype: message.subtype,
      eligible: message.author === "person" ? 1 : 0,
      author_role: role,
      text: kept ? message.text : null,
      files: kept ? JSON.stringify(message.files) : null,
      content_hash: contentHash,
      mentions_bot: kept && message.mentionsBot ? 1 : 0,
      edited_ts: message.editedTs,
      version: message.version,
    });
    purged = kept
      ? await syncMessageFiles(transaction, channelId, ts, message.files)
      : await forgetMessageFiles(transaction, channelId, ts);
  }

  // A thread's newest reply moves on even when the message doesn't, as when history returns an
  // unchanged root.
  const replyTs = message.isReply ? ts : message.latestReplyTs;
  if (replyTs !== null) await noteReply(transaction, channelId, message.rootTs, replyTs);
  return { decision, role, contentHash, mentionedBot: row?.mentions_bot === 1, purged };
}

/**
 * Merges a delete into the ledger. A message the ledger never saw leaves a tombstone, so its late
 * original stays deleted.
 */
export async function storeDelete(
  transaction: Bun.SQL,
  linkId: string,
  channelId: string,
  ts: SlackTs,
): Promise<StoredDelete> {
  const decision = mergeDelete(storedMessage(await readMessage(transaction, channelId, ts)));
  if (decision.kind === "ignore") return { decision, purged: [] };
  await writeMessage(
    transaction,
    linkId,
    channelId,
    ts,
    decision,
    decision.kind === "insert"
      ? { eligible: 0, author_role: "other", deleted: 1, version: ts }
      : { deleted: 1, text: null, files: null, content_hash: null, mentions_bot: 0 },
  );
  return { decision, purged: await forgetMessageFiles(transaction, channelId, ts) };
}

/** Tracks a request's thread from its newest known reply. Returns whether it was untracked. */
export async function trackThread(
  transaction: Bun.SQL,
  channelId: string,
  threadTs: SlackTs,
  latestReplyTs: SlackTs | null,
): Promise<boolean> {
  const tracked = await transaction`
    INSERT INTO threads (channel_id, thread_ts, tracked_reason, latest_reply_ts)
    VALUES (${channelId}, ${threadTs}, 'request', ${latestReplyTs})
    ON CONFLICT DO NOTHING
    RETURNING thread_ts
  `;
  return tracked.length > 0;
}

/**
 * Raises a tracked thread's newest reply to `replyTs`, never lowering it. Threads the bridge
 * doesn't track are left alone.
 */
export async function noteReply(
  transaction: Bun.SQL,
  channelId: string,
  threadTs: SlackTs,
  replyTs: SlackTs,
): Promise<void> {
  const [thread] = await transaction<{ latest_reply_ts: SlackTs | null }[]>`
    SELECT latest_reply_ts FROM threads WHERE channel_id = ${channelId} AND thread_ts = ${threadTs}
  `;
  if (!thread) return;
  if (thread.latest_reply_ts !== null && compareTs(replyTs, thread.latest_reply_ts) <= 0) return;
  await transaction`
    UPDATE threads SET latest_reply_ts = ${replyTs}
    WHERE channel_id = ${channelId} AND thread_ts = ${threadTs}
  `;
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

async function isTracked(transaction: Bun.SQL, channelId: string, threadTs: SlackTs) {
  const [thread] = await transaction`
    SELECT 1 FROM threads WHERE channel_id = ${channelId} AND thread_ts = ${threadTs}
  `;
  return thread !== undefined;
}

async function writeMessage(
  transaction: Bun.SQL,
  linkId: string,
  channelId: string,
  ts: SlackTs,
  decision: Applied,
  columns: Record<string, string | number | null>,
): Promise<void> {
  const row = { ...columns };
  if (decision.change !== null) {
    row.updated_seq = await appendChange(transaction, linkId, channelId, ts, decision.change);
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
  linkId: string,
  channelId: string,
  ts: SlackTs,
  kind: "new" | "edited" | "deleted",
): Promise<number> {
  const [change] = await transaction<{ seq: number }[]>`
    INSERT INTO changes (link_id, channel_id, ts, kind)
    VALUES (${linkId}, ${channelId}, ${ts}, ${kind})
    RETURNING seq
  `;
  return change!.seq;
}

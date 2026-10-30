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
import type { SlackFile } from "@slackapi/model/files";
import type { SlackMessage } from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";

// The ledger's reads and writes.
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

/** A file a kept message shares, under the number the lead reads it by. */
export type SharedFile = {
  /** The file's number, which the lead writes as f12. */
  id: number;
  /** The message that shares it. */
  ts: SlackTs;
  /** Whoever wrote the message, or null when Slack named no one. */
  sharerId: string | null;
  file: SlackFile;
};

type Applied = Exclude<MergeDecision, { kind: "ignore" }>;

type MessageRow = {
  version: SlackTs;
  deleted: number;
  content_hash: string | null;
  mentions_bot: number;
};

type SharedFileRow = {
  id: number;
  ts: SlackTs;
  sharerId: string | null;
  fileId: string;
  whole: number;
  name: string | null;
  mimeType: string | null;
  mode: string | null;
  size: number | null;
  uploaderId: string | null;
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
      user_id: kept ? message.userId : null,
      author_role: role,
      text: kept ? message.text : null,
      content_hash: contentHash,
      mentions_bot: kept && message.mentionsBot ? 1 : 0,
      edited_ts: message.editedTs,
      version: message.version,
    });
    await storeFiles(transaction, channelId, ts, kept ? message.files : []);
  }
  return { decision, role, mentionedBot: row?.mentions_bot === 1 };
}

/**
 * Merges a delete into the ledger, forgetting the message's text, its files and who wrote it. A
 * message the ledger never saw leaves a tombstone, so its late original stays deleted.
 */
export async function storeDelete(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
): Promise<void> {
  const decision = mergeDelete(storedMessage(await readMessage(transaction, channelId, ts)));
  if (decision.kind === "ignore") return;
  await writeMessage(
    transaction,
    channelId,
    ts,
    decision,
    decision.kind === "insert"
      ? { author_role: "other", deleted: 1, version: ts }
      : { deleted: 1, user_id: null, text: null, content_hash: null, mentions_bot: 0 },
  );
  await storeFiles(transaction, channelId, ts, []);
}

/** What our newest message in `message`'s thread from before it says, if one is there. */
export async function readOwnTextBefore(
  transaction: Bun.SQL,
  { channelId, rootTs, ts }: Pick<SlackMessage, "channelId" | "rootTs" | "ts">,
): Promise<string | null> {
  const ours = await transaction<{ ts: SlackTs; text: string }[]>`
    SELECT ts, text FROM messages
    WHERE channel_id = ${channelId} AND author_role = 'self' AND text IS NOT NULL
      AND (ts = ${rootTs} OR thread_ts = ${rootTs})
  `;
  const earlier = ours.filter((message) => compareTs(message.ts, ts) < 0);
  return earlier.toSorted((a, b) => compareTs(a.ts, b.ts)).at(-1)?.text ?? null;
}

/**
 * Forgets every message last changed longer ago than the ledger keeps one, a tombstone too, since
 * Slack never shows a deleted message again. Then it forgets every change no message points at,
 * which activity never reads, so the digest reads as it did.
 */
export async function forgetOldActivity(transaction: Bun.SQL, now: number): Promise<void> {
  // SQLite casts a ts to its whole seconds.
  const before = Math.floor((now - RETENTION_MS) / 1000);
  await transaction`DELETE FROM messages WHERE CAST(version AS INTEGER) < ${before}`;
  await transaction`DELETE FROM changes WHERE seq NOT IN (SELECT updated_seq FROM messages)`;
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

/**
 * Makes a message's file rows describe the files it shares now. A file it still shares keeps its
 * row, and so the reference the lead reads it by. An upsert would also keep the row, but SQLite
 * would use up a reference for each file it updated.
 */
async function storeFiles(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
  files: readonly SlackFile[],
): Promise<void> {
  await transaction`
    DELETE FROM message_files WHERE channel_id = ${channelId} AND ts = ${ts}
      AND file_id NOT IN ${transaction(files.map((file) => file.id))}
  `;
  for (const file of files) {
    const columns = fileColumns(file);
    const [stored] = await transaction`
      UPDATE message_files SET ${transaction(columns)}
      WHERE channel_id = ${channelId} AND ts = ${ts} AND file_id = ${file.id}
      RETURNING id
    `;
    if (!stored) {
      const row = { channel_id: channelId, ts, file_id: file.id, ...columns };
      await transaction`INSERT INTO message_files ${transaction(row)}`;
    }
  }
}

function fileColumns(file: SlackFile): Record<string, string | number | null> {
  if (!file.whole) {
    return { whole: 0, name: null, mime_type: null, mode: null, size: null, uploader_id: null };
  }
  return {
    whole: 1,
    name: file.name,
    mime_type: file.mimeType,
    mode: file.mode,
    size: file.size,
    uploader_id: file.uploaderId,
  };
}

/** The files the messages at `tsList` in `channelId` share, in the order the ledger stored them. */
export async function readSharedFiles(
  sql: Bun.SQL,
  channelId: string,
  tsList: readonly SlackTs[],
): Promise<SharedFile[]> {
  const rows = await sql<SharedFileRow[]>`
    ${selectSharedFiles(sql)}
    WHERE f.channel_id = ${channelId} AND f.ts IN ${sql(tsList)}
    ORDER BY f.id
  `;
  return rows.map(sharedFile);
}

/** File `id` of `channelId`, or null when no message there shares it now. */
export async function readSharedFile(
  sql: Bun.SQL,
  channelId: string,
  id: number,
): Promise<SharedFile | null> {
  const [row] = await sql<SharedFileRow[]>`
    ${selectSharedFiles(sql)} WHERE f.channel_id = ${channelId} AND f.id = ${id}
  `;
  return row ? sharedFile(row) : null;
}

function selectSharedFiles(sql: Bun.SQL) {
  return sql`
    SELECT f.id, f.ts, m.user_id AS sharerId, f.file_id AS fileId, f.whole, f.name,
      f.mime_type AS mimeType, f.mode, f.size, f.uploader_id AS uploaderId
    FROM message_files f JOIN messages m ON m.channel_id = f.channel_id AND m.ts = f.ts
  `;
}

function sharedFile({ id, ts, sharerId, fileId, whole, ...columns }: SharedFileRow): SharedFile {
  if (whole === 0) return { id, ts, sharerId, file: { id: fileId, whole: false } };
  // message_files holds every column of a whole file but its name.
  const { name, mimeType, mode, size, uploaderId } = columns;
  return {
    id,
    ts,
    sharerId,
    file: {
      id: fileId,
      whole: true,
      name,
      mimeType: mimeType!,
      mode: mode!,
      size: size!,
      uploaderId: uploaderId!,
    },
  };
}

/** Deletes the messages, their files and the changes the ledger kept from a link's channel. */
export async function deleteLinkActivity(
  transaction: Bun.SQL,
  link: { slackChannelId: string },
): Promise<void> {
  await transaction`DELETE FROM changes WHERE channel_id = ${link.slackChannelId}`;
  await transaction`DELETE FROM messages WHERE channel_id = ${link.slackChannelId}`;
}

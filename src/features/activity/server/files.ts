import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SlackFile } from "@slackapi/model/messages";
import type { SlackTs } from "@slackapi/model/ts";

// The files the ledger indexes.
//
// Forgetting a file returns its local copy instead of removing it, and the caller removes the copy
// only once the transaction commits, so a rollback never loses a copy that a row still names.

/**
 * Indexes the files a kept message has and forgets the ones it no longer has. Returns the local
 * copies of the forgotten files.
 */
export async function syncMessageFiles(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
  files: readonly SlackFile[],
): Promise<string[]> {
  for (const file of files) {
    await transaction`
      INSERT INTO files (file_id, channel_id, ts, state, size, mime)
      VALUES (${file.id}, ${channelId}, ${ts}, 'indexed', ${file.size}, ${file.mimetype})
      ON CONFLICT(file_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        ts = excluded.ts,
        size = excluded.size,
        mime = excluded.mime
    `;
  }
  if (!files.length) return forgetMessageFiles(transaction, channelId, ts);
  const kept = files.map((file) => file.id);
  return localCopies(
    await transaction`
      DELETE FROM files
      WHERE channel_id = ${channelId} AND ts = ${ts} AND file_id NOT IN ${transaction(kept)}
      RETURNING local_path
    `,
  );
}

/** Forgets every file of a message that was deleted or keeps only a marker now. */
export async function forgetMessageFiles(
  transaction: Bun.SQL,
  channelId: string,
  ts: SlackTs,
): Promise<string[]> {
  return localCopies(
    await transaction`
      DELETE FROM files WHERE channel_id = ${channelId} AND ts = ${ts} RETURNING local_path
    `,
  );
}

/** Forgets a file Slack deleted. Returns its local copies, or null when the ledger never had it. */
export async function forgetFile(transaction: Bun.SQL, fileId: string): Promise<string[] | null> {
  const forgotten = await transaction`
    DELETE FROM files WHERE file_id = ${fileId} RETURNING local_path
  `;
  return forgotten.length ? localCopies(forgotten) : null;
}

/**
 * Removes local copies whose rows are gone. A copy that's already gone is fine, and a path that
 * leaves the files folder is never touched.
 */
export async function removeLocalCopies(
  filesFolder: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const copy = resolve(filesFolder, path);
    const inside = relative(filesFolder, copy);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      console.error("Kept a file the ledger forgot because its path leaves the files folder.");
      continue;
    }
    // A copy's name can come from Slack, so the error leaves it out.
    await rm(copy, { force: true }).catch((error: unknown) => {
      console.error(`Couldn't remove a deleted file's local copy: ${errorCode(error)}`);
    });
  }
}

function localCopies(rows: { local_path: string | null }[]): string[] {
  return rows.flatMap((row) => (row.local_path === null ? [] : [row.local_path]));
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "unknown error";
}

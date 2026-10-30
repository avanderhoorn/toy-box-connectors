// The files the bridge uploads to show a post's images.
//
// A queued item names its files in `outbox_files`, in the order it shows them, and its payload
// holds what each shows. Every other file the bridge uploaded is owed a delete in
// `file_deletions` until Slack confirms it gone: one a command uploaded, until it queues the post
// that shows it, and one a post that won't go out, or was retracted, no longer shows.

/** A delete the bridge owes Slack. */
export type OwedDeletion = { fileId: string; attempts: number; createdAt: number };

/** Records the files a queued item shows, in order, which its command no longer owes deletes. */
export async function attachFiles(
  tx: Bun.SQL,
  itemId: string,
  fileIds: readonly string[],
): Promise<void> {
  for (const [position, fileId] of fileIds.entries())
    await tx`INSERT INTO outbox_files ${tx({ item_id: itemId, position, file_id: fileId })}`;
  if (fileIds.length) await tx`DELETE FROM file_deletions WHERE file_id IN ${tx(fileIds)}`;
}

/** The files an item shows, in order. */
export async function readItemFiles(sql: Bun.SQL, itemId: string): Promise<string[]> {
  const rows = await sql<{ file_id: string }[]>`
    SELECT file_id FROM outbox_files WHERE item_id = ${itemId} ORDER BY position
  `;
  return rows.map((row) => row.file_id);
}

/**
 * Owes Slack a delete of each of `fileIds`, due at `dueAt` or sooner if it already is. A file keeps
 * when it was first owed, which bounds how long the bridge tries.
 */
export async function oweFileDeletes(
  tx: Bun.SQL,
  fileIds: readonly string[],
  dueAt: number,
  now: number,
): Promise<void> {
  for (const fileId of fileIds)
    await tx`
      INSERT INTO file_deletions (file_id, due_at, created_at) VALUES (${fileId}, ${dueAt}, ${now})
      ON CONFLICT (file_id) DO UPDATE SET due_at = MIN(due_at, excluded.due_at)
    `;
}

/** Owes the deletes of an item's files at once, since it won't show them. */
export async function oweItemFiles(tx: Bun.SQL, itemId: string, now: number): Promise<void> {
  await oweFileDeletes(tx, await readItemFiles(tx, itemId), now, now);
  await tx`DELETE FROM outbox_files WHERE item_id = ${itemId}`;
}

/** The deletes due by `now`, soonest first. */
export async function readDueDeletions(sql: Bun.SQL, now: number): Promise<OwedDeletion[]> {
  const rows = await sql<{ file_id: string; attempts: number; created_at: number }[]>`
    SELECT file_id, attempts, created_at FROM file_deletions WHERE due_at <= ${now}
    ORDER BY due_at, file_id LIMIT 100
  `;
  return rows.map((row) => ({
    fileId: row.file_id,
    attempts: row.attempts,
    createdAt: row.created_at,
  }));
}

/** Settles a delete Slack confirmed, or one the bridge gave up on. */
export async function forgetDeletion(tx: Bun.SQL, fileId: string): Promise<void> {
  await tx`DELETE FROM file_deletions WHERE file_id = ${fileId}`;
}

/** Owes again, at `dueAt`, a delete Slack didn't confirm. */
export async function deferDeletion(tx: Bun.SQL, fileId: string, dueAt: number): Promise<void> {
  await tx`
    UPDATE file_deletions SET attempts = attempts + 1, due_at = ${dueAt} WHERE file_id = ${fileId}
  `;
}

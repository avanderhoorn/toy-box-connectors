import { readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { removeLocalCopies } from "@activity/server/files";
import type { BridgeDatabase } from "@bridge/server/database";
import { audit } from "./audit";

// Purges.
//
// What the bridge keeps, and when it lets go, is a promise the trust section makes, so each
// table's fate in a purge is decided here, and a test fails when a table is added without one. A
// purge deletes rows in its transaction and returns the local copies of the files it forgot, which
// the caller removes once the transaction commits. At startup, before anything can fetch, the
// sweep removes every file no row names, so a crash between a purge's commit and its deletes, or
// a delete that failed, leaves no copy behind.

/** What a purge does to a table's rows. */
export type TablePurge = "delete" | "keep";

/**
 * What uninstalling the app does to each table, children before the tables they reference. The
 * installation stays, marked uninstalled with no owner, and so does the record of the purge.
 */
export const uninstallPurge = {
  installation: "keep",
  receipts: "delete",
  rate_limits: "delete",
  channel_info: "delete",
  channel_aliases: "delete",
  users: "delete",
  user_aliases: "delete",
  claims: "delete",
  link_routines: "delete",
  allowlist: "delete",
  approvals: "delete",
  audit: "delete",
  messages: "delete",
  changes: "delete",
  threads: "delete",
  coverage: "delete",
  cursors: "delete",
  files: "delete",
  wake_state: "delete",
  wakes: "delete",
  request_messages: "delete",
  requests: "delete",
  outbox: "delete",
  outbox_channels: "delete",
  toybox_streams: "delete",
  links: "delete",
} as const satisfies Record<string, TablePurge>;

/**
 * Deletes everything uninstalling purges and records that the purge happened. Returns the local
 * copies of the files it forgot.
 */
export async function purgeForUninstall(transaction: Bun.SQL, now: number): Promise<string[]> {
  const copies = await purgeTables(transaction, uninstallPurge);
  await audit(transaction, { actor: "bridge", action: "purge", subject: "uninstalled" }, now);
  return copies;
}

/**
 * What resetting does to each table: everything uninstalling deletes, and the installation with
 * its owner, so the next start stores whatever installation its tokens name and someone claims it
 * again. Nothing allowed or queued under the old owner outlives it. The audit log stays, holding
 * IDs and reasons only, so what led to the reset can still be read.
 */
export const resetPurge = {
  ...uninstallPurge,
  installation: "delete",
  audit: "keep",
} as const satisfies Record<string, TablePurge>;

/**
 * Deletes everything resetting purges and records that the operator reset the bridge. Returns the
 * local copies of the files it forgot.
 */
export async function purgeForReset(transaction: Bun.SQL, now: number): Promise<string[]> {
  const copies = await purgeTables(transaction, resetPurge);
  await audit(transaction, { actor: "operator", action: "reset" }, now);
  return copies;
}

/**
 * Deletes every table `purges` marks, in order, and returns the local copies of the files it
 * forgot. It never touches SQLite's own tables, so numbers keep counting from where they were.
 */
async function purgeTables(
  transaction: Bun.SQL,
  purges: Record<string, TablePurge>,
): Promise<string[]> {
  const copies = await transaction<{ local_path: string | null }[]>`
    SELECT local_path FROM files WHERE local_path IS NOT NULL
  `;
  for (const [table, purge] of Object.entries(purges)) {
    if (purge === "delete") await transaction.unsafe(`DELETE FROM ${table}`);
  }
  return copies.flatMap((copy) => (copy.local_path === null ? [] : [copy.local_path]));
}

/**
 * Removes every file in the files folder that no row names. It runs at startup before anything
 * can fetch, so no copy is being written. A folder that doesn't exist yet holds nothing to remove,
 * and one that can't be read rejects, so the bridge doesn't start with copies it can't account for.
 */
export async function sweepFiles(database: BridgeDatabase, filesFolder: string): Promise<void> {
  const rows = await database.read(
    (sql) => sql<{ local_path: string }[]>`
      SELECT local_path FROM files WHERE local_path IS NOT NULL
    `,
  );
  const named = new Set(rows.map((row) => normalize(row.local_path)));
  const unnamed = (await listFiles(filesFolder)).filter((path) => !named.has(path));
  await removeLocalCopies(filesFolder, unnamed);
}

/** Every file below `folder`, relative to it. Links aren't followed. */
async function listFiles(folder: string, inside = ""): Promise<string[]> {
  const entries = await readdir(join(folder, inside), { withFileTypes: true }).catch(
    (error: unknown) => {
      if (inside === "" && error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(inside, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(folder, path)));
    else paths.push(path);
  }
  return paths;
}

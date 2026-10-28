// The bridge database.
//
// `bridge.db` holds every link, message, request and outbox item in one
// SQLite file behind one connection. Bun's SQLite adapter runs any statement
// issued while a transaction is open inside that transaction, so every
// statement, reads included, goes through one serial queue, and every write
// runs in its own `BEGIN IMMEDIATE` transaction.

import { pathToFileURL } from "node:url";
import { initializeActivitySchema, numberGapsOnce } from "@activity/server/schema";
import { initializeLinkSchema, numberApprovalsOnce } from "@links/server/schema";
import {
  addOutboxDeliverySchema,
  initializeOutboxSchema,
  numberOutboxItemsOnce,
} from "@outbox/server/schema";
import { initializeRequestSchema } from "@requests/server/schema";
import { initializeSlackApiSchema } from "@slackapi/server/schema";
import { initializeToyBoxSchema } from "@toybox/server/schema";
import { initializeWakeSchema } from "@wakes/server/schema";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import { BridgeRefusedError } from "./refusal";

/** One schema change, run inside the migration transaction. */
export type Migration = (transaction: Bun.SQL) => Promise<void>;

/**
 * Every schema version of `bridge.db`, oldest first. Feature schemas are
 * composed here so one connection owns ordering and transactions without
 * owning each feature's persistence model. Once released, a migration never
 * changes, including the feature schemas it installs, so later changes append
 * a new one.
 */
export const bridgeMigrations: readonly Migration[] = [
  async (transaction) => {
    await initializeSlackApiSchema(transaction);
    await initializeLinkSchema(transaction);
    await initializeActivitySchema(transaction);
    await initializeRequestSchema(transaction);
    await initializeWakeSchema(transaction);
    await initializeToyBoxSchema(transaction);
    await initializeOutboxSchema(transaction);
  },
  addOutboxDeliverySchema,
  async (transaction) => {
    await numberOutboxItemsOnce(transaction);
    await numberApprovalsOnce(transaction);
    await numberGapsOnce(transaction);
  },
];

/** The settings that keep an acked event on disk through a power loss and keep references whole. */
const requiredSettings = {
  journal_mode: "wal",
  synchronous: 2,
  fullfsync: 1,
  foreign_keys: 1,
} as const;

export class BridgeDatabase {
  private readonly queue = new SerialTaskQueue();

  constructor(private readonly sql: Bun.SQL) {}

  /** Runs `operation` alone on the connection, outside any transaction. */
  read<Result>(operation: (sql: Bun.SQL) => Promise<Result>): Promise<Result> {
    return this.queue.enqueue(() => operation(this.sql));
  }

  /**
   * Runs `operation` in its own `BEGIN IMMEDIATE` transaction, which commits
   * when it resolves and rolls back when it throws. Every other statement waits
   * for it, so it must await only its own SQL.
   */
  write<Result>(operation: (transaction: Bun.SQL) => Promise<Result>): Promise<Result> {
    return this.queue.enqueue(() => this.sql.begin("IMMEDIATE", operation));
  }

  /** Closes the connection once everything queued before it has run. */
  close(): Promise<void> {
    return this.queue.enqueue(() => this.sql.close());
  }
}

/**
 * Opens `bridge.db` at `path`, refuses to use it unless SQLite applied every
 * required setting, and brings its schema up to date.
 */
export async function openBridgeDatabase(
  path: string,
  migrations: readonly Migration[] = bridgeMigrations,
): Promise<BridgeDatabase> {
  // A plain filename ends at its first `?`, so a URL keeps every path exact.
  const sql = new Bun.SQL({ adapter: "sqlite", filename: pathToFileURL(path), strict: true });
  try {
    await configure(sql, path);
    await migrate(sql, path, migrations);
  } catch (error) {
    await sql.close();
    throw error;
  }
  return new BridgeDatabase(sql);
}

/** Names each required setting that SQLite reported a different value for. */
export function unmetSettings(reported: Record<string, unknown>): string[] {
  return Object.entries(requiredSettings)
    .filter(([name, value]) => reported[name] !== value)
    .map(([name, value]) => `${name} is ${String(reported[name])}, not ${value}`);
}

async function configure(sql: Bun.SQL, path: string): Promise<void> {
  // SQLite ignores a journal mode the file system can't support instead of
  // failing, so every setting is read back before the bridge trusts it.
  await sql`PRAGMA journal_mode = WAL`;
  await sql`PRAGMA synchronous = FULL`;
  // macOS fsync can leave a commit in the drive's cache, and F_FULLFSYNC flushes it.
  await sql`PRAGMA fullfsync = ON`;
  await sql`PRAGMA foreign_keys = ON`;
  // A backup or the sqlite3 shell may hold the write lock for a moment.
  await sql`PRAGMA busy_timeout = 5000`;

  const reported: Record<string, unknown> = {};
  for (const name of Object.keys(requiredSettings)) {
    const [row] = await sql.unsafe<Record<string, unknown>[]>(`PRAGMA ${name}`);
    reported[name] = row?.[name];
  }

  const unmet = unmetSettings(reported);
  if (unmet.length > 0) {
    throw new BridgeRefusedError(
      `SQLite can't run ${path} the way the bridge needs (${unmet.join(", ")}). Keep the data folder on a local disk.`,
    );
  }
}

async function migrate(sql: Bun.SQL, path: string, migrations: readonly Migration[]) {
  await sql.begin("IMMEDIATE", async (transaction) => {
    const [{ user_version: version }] = await transaction<{ user_version: number }[]>`
      PRAGMA user_version
    `;
    if (version > migrations.length) {
      throw new BridgeRefusedError(
        `${path} has schema version ${version}, but this toy-box-slack knows only ${migrations.length}. Run the newer toy-box-slack that wrote it.`,
      );
    }
    if (version === migrations.length) return;

    for (const migration of migrations.slice(version)) await migration(transaction);
    await transaction.unsafe(`PRAGMA user_version = ${migrations.length}`);
  });
}

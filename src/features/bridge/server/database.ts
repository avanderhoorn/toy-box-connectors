// The bridge database.
//
// `bridge.db` holds every link, message, request and outbox item in one
// SQLite file behind one connection. Bun's SQLite adapter runs any statement
// issued while a transaction is open inside that transaction, so every
// statement, reads included, goes through one serial queue, and every write
// runs in its own `BEGIN IMMEDIATE` transaction.

import { initializeActivitySchema } from "@activity/server/schema";
import { initializeLinkSchema } from "@links/server/schema";
import { allowOutboxPosts, initializeOutboxSchema } from "@outbox/server/schema";
import { initializeRequestSchema } from "@requests/server/schema";
import { initializeSlackApiSchema } from "@slackapi/server/schema";
import { initializeWakeSchema } from "@wakes/server/schema";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import { BridgeRefusedError } from "./refusal";

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
 * Opens `bridge.db` at `path` with the settings that keep an acked event on
 * disk through a power loss, and creates its tables when it's new. Refuses one
 * that another version of the bridge made.
 */
export async function openBridgeDatabase(path: string): Promise<BridgeDatabase> {
  const sql = new Bun.SQL({ adapter: "sqlite", filename: path, strict: true });
  try {
    await configure(sql);
    await initializeSchema(sql, path);
  } catch (error) {
    await sql.close();
    throw error;
  }
  return new BridgeDatabase(sql);
}

async function configure(sql: Bun.SQL): Promise<void> {
  await sql`PRAGMA journal_mode = WAL`;
  await sql`PRAGMA synchronous = FULL`;
  // macOS fsync can leave a commit in the drive's cache, and F_FULLFSYNC flushes it.
  await sql`PRAGMA fullfsync = ON`;
  await sql`PRAGMA foreign_keys = ON`;
  // A backup or the sqlite3 shell may hold the write lock for a moment.
  await sql`PRAGMA busy_timeout = 5000`;
}

// Feature schemas are composed here so one connection owns ordering and transactions without
// owning each feature's persistence model. Owners update by installing a release and restarting, so
// changing a table raises the version, records its tables in `schemas/`, and migrates a `bridge.db`
// that any recorded version made. The bridge refuses a `bridge.db` any other version made rather
// than fail on it later, and one a newer version made needs that version, not a fresh start.
const schemaVersion = 3;

/** Each step takes a `bridge.db` from the version it's keyed by to the next one. */
const migrations: Record<number, (transaction: Bun.SQL) => Promise<void>> = {
  2: allowOutboxPosts,
};

async function initializeSchema(sql: Bun.SQL, path: string): Promise<void> {
  await sql.begin("IMMEDIATE", async (transaction) => {
    const [{ user_version: version }] = await transaction<{ user_version: number }[]>`
      PRAGMA user_version
    `;
    if (version === schemaVersion) return;
    if (version > schemaVersion) {
      throw new BridgeRefusedError(
        `${path} was made by a newer version of toy-box-slack, which this one can't read. Install the newer version again and start the bridge.`,
      );
    }
    if (version === 0) await createSchema(transaction);
    else if (version in migrations) {
      for (let step = version; step < schemaVersion; step++) await migrations[step]!(transaction);
    } else {
      throw new BridgeRefusedError(
        `${path} was made by another version of toy-box-slack. The bridge has to start over, which forgets every link, so stop the bridge, remove bridge.db and its -wal/-shm files, and start it again. Then link each channel and allow its people again.`,
      );
    }
    await transaction.unsafe(`PRAGMA user_version = ${schemaVersion}`);
  });
}

async function createSchema(transaction: Bun.SQL): Promise<void> {
  await initializeSlackApiSchema(transaction);
  await initializeLinkSchema(transaction);
  await initializeActivitySchema(transaction);
  await initializeRequestSchema(transaction);
  await initializeWakeSchema(transaction);
  await initializeOutboxSchema(transaction);
}

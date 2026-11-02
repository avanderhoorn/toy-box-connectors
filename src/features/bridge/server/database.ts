// The bridge database.
//
// `bridge.db` holds every link, message, request and outbox item in one
// SQLite file behind one connection. Bun's SQLite adapter runs any statement
// issued while a transaction is open inside that transaction, so every
// statement, reads included, goes through one serial queue, and every write
// runs in its own `BEGIN IMMEDIATE` transaction.

import {
  addMessageFiles,
  initializeActivitySchema,
  numberLedgerChanges,
} from "@activity/server/schema";
import { addLinkChannelName, initializeLinkSchema } from "@links/server/schema";
import { addOutboxImages, allowOutboxPosts, initializeOutboxSchema } from "@outbox/server/schema";
import { initializeRequestSchema } from "@requests/server/schema";
import { forgetAuthFailure, initializeSlackApiSchema } from "@slackapi/server/schema";
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
  // A backup or the sqlite3 shell may hold the write lock for a moment.
  await sql`PRAGMA busy_timeout = 5000`;
}

/** The tables a version of the bridge makes, and the steps that bring older recorded versions to it. */
export interface Schema {
  version: number;
  create: (transaction: Bun.SQL) => Promise<void>;
  /**
   * Each step takes a `bridge.db` from the version it's keyed by to the next one. Steps run with
   * foreign keys off, so rebuilding a table keeps the rows that reference it, and a step that means
   * to drop those rows deletes them itself.
   */
  migrations: Record<number, (transaction: Bun.SQL) => Promise<void>>;
}

// Feature schemas are composed here so one connection owns ordering and transactions without
// owning each feature's persistence model. Owners update by installing a release and restarting, so
// changing a table raises the version, records its tables in `schemas/`, and migrates a `bridge.db`
// that any recorded version made. The bridge refuses a `bridge.db` any other version made rather
// than fail on it later, and one a newer version made needs that version, not a fresh start.
const bridgeSchema: Schema = {
  version: 6,
  create: createSchema,
  migrations: {
    2: allowOutboxPosts,
    3: addMessageFiles,
    4: async (transaction) => {
      await addOutboxImages(transaction);
      await addLinkChannelName(transaction);
    },
    5: async (transaction) => {
      await forgetAuthFailure(transaction);
      await numberLedgerChanges(transaction);
    },
  },
};

/**
 * Creates or migrates `schema`'s tables in one transaction, then leaves foreign keys on for every
 * statement after. They're off while it runs, as SQLite's guide to changing a table says, since
 * SQLite ignores the pragma inside a transaction, and with them on, dropping a table a step
 * rebuilds deletes every row that references it, with no error. The bridge turns them off itself
 * rather than trust the default of the SQLite macOS ships, which an update to macOS can change.
 */
export async function initializeSchema(
  sql: Bun.SQL,
  path: string,
  schema: Schema = bridgeSchema,
): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`;
  try {
    await sql.begin("IMMEDIATE", (transaction) => migrate(transaction, path, schema));
  } finally {
    await sql`PRAGMA foreign_keys = ON`;
  }
}

async function migrate(transaction: Bun.SQL, path: string, schema: Schema): Promise<void> {
  const [{ user_version: version }] = await transaction<{ user_version: number }[]>`
    PRAGMA user_version
  `;
  if (version === schema.version) return;
  if (version > schema.version) {
    throw new BridgeRefusedError(
      `${path} was made by a newer version of toy-box-slack, which this one can't read. Install the newer version again and start the bridge.`,
    );
  }
  if (version === 0) await schema.create(transaction);
  else if (version in schema.migrations) {
    for (let step = version; step < schema.version; step++) {
      await schema.migrations[step]!(transaction);
    }
    await checkReferences(transaction, path);
  } else {
    throw new BridgeRefusedError(
      `${path} was made by another version of toy-box-slack. The bridge has to start over, which forgets every link, so stop the bridge, remove bridge.db and its -wal/-shm files, and start it again. Then link each channel and allow its people again.`,
    );
  }
  await transaction.unsafe(`PRAGMA user_version = ${schema.version}`);
}

/**
 * Refuses the update, which rolls it back, when a row points at a row the database doesn't have.
 * Only an update checks, so a row a sqlite3 session left refuses an update, not every start.
 */
async function checkReferences(transaction: Bun.SQL, path: string): Promise<void> {
  const dangling = await transaction<{ table: string }[]>`PRAGMA foreign_key_check`;
  if (dangling.length === 0) return;
  const tables = [...new Set(dangling.map((row) => row.table))].join(", ");
  throw new BridgeRefusedError(
    `Updating ${path} would leave rows in ${tables} that point at nothing, so toy-box-slack left it as it was, and the version that made it still reads it. If you changed it in sqlite3, delete the rows its PRAGMA foreign_key_check lists, then start the bridge again.`,
  );
}

async function createSchema(transaction: Bun.SQL): Promise<void> {
  await initializeSlackApiSchema(transaction);
  await initializeLinkSchema(transaction);
  await initializeActivitySchema(transaction);
  await initializeRequestSchema(transaction);
  await initializeWakeSchema(transaction);
  await initializeOutboxSchema(transaction);
}

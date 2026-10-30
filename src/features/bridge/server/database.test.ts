import { describe, expect, onTestFinished, test } from "bun:test";
import { basename, join } from "node:path";
import { createStoredLink } from "@links/server/testFixtures";
import { queuePublication } from "@outbox/server/database";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { BridgeDatabase, openBridgeDatabase } from "./database";
import { createDatabaseMadeBy, createTestFolder, openTestDatabase } from "./testFixtures";

const schemas = join(import.meta.dir, "schemas");
const recordedVersions = [...new Bun.Glob("*.sql").scanSync(schemas)]
  .map((file) => Number(basename(file, ".sql")))
  .sort((a, b) => a - b);

async function open(path: string): Promise<BridgeDatabase> {
  const database = await openBridgeDatabase(path);
  onTestFinished(() => database.close());
  return database;
}

/** Leave at `path` a new `bridge.db` as `version` made it, from the tables recorded for it. */
async function createRecordedDatabase(path: string, version: number): Promise<void> {
  const sql = new Bun.SQL({ adapter: "sqlite", filename: path });
  try {
    await sql.unsafe(await Bun.file(join(schemas, `${version}.sql`)).text());
    await sql.unsafe(`PRAGMA user_version = ${version}`);
  } finally {
    await sql.close();
  }
}

/** Each table and index as SQL, leaving out comments, layout, and the quotes a renamed table gets. */
async function schemaOf(sql: Bun.SQL): Promise<string[]> {
  const objects = await sql<{ sql: string }[]>`
    SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `;
  return objects.map((object) =>
    object.sql
      .replace(/--.*$/gm, "")
      .replace(/"(\w+)"/g, "$1")
      .replace(/\s*([(),])\s*/g, "$1")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("openBridgeDatabase", () => {
  test("runs with the settings that keep each commit through a power loss and references whole", async () => {
    const database = await openTestDatabase();

    const [pragmas] = await database.read(
      (sql) => sql`
        SELECT journal_mode, synchronous, fullfsync, foreign_keys
        FROM pragma_journal_mode, pragma_synchronous, pragma_fullfsync, pragma_foreign_keys
      `,
    );

    expect(pragmas).toEqual({ journal_mode: "wal", synchronous: 2, fullfsync: 1, foreign_keys: 1 });
  });

  test.each(recordedVersions)(
    "opens a bridge.db that version %d made, with the tables a new one gets",
    async (version) => {
      const path = join(createTestFolder(), "bridge.db");
      await createRecordedDatabase(path, version);

      const database = await open(path);

      const created = await openTestDatabase();
      expect(await database.read(schemaOf)).toEqual(await created.read(schemaOf));
    },
  );

  test("keeps a version 2 outbox's items and numbering once its newest item is deleted", async () => {
    const path = join(createTestFolder(), "bridge.db");
    await createRecordedDatabase(path, 2);
    const made = new BridgeDatabase(new Bun.SQL({ adapter: "sqlite", filename: path }));
    await createStoredLink(made);
    await createStoredRequest(made);
    await createStoredOutboxItem(made, 1, { state: "sent" });
    const notes = { kind: "publication", request_id: null, thread_ts: null, series: "notes" };
    await createStoredOutboxItem(made, 2, { ...notes, scheduled_at: 1, state: "sent" });
    await createStoredOutboxItem(made, 3, { ...notes, scheduled_at: 2, state: "failed" });
    await made.write((transaction) => transaction`DELETE FROM outbox WHERE number = 3`);
    const items = await made.read((sql) => sql`SELECT * FROM outbox ORDER BY number`);
    await made.close();

    const database = await open(path);

    expect(await database.read((sql) => sql`SELECT * FROM outbox ORDER BY number`)).toEqual(items);
    const slot = { linkId: "link", series: "notes", scheduledAt: 3, text: "Notes" };
    const next = await database.write((transaction) => queuePublication(transaction, slot, 3));
    expect(next.number).toBe(4);
  });

  test("refuses a bridge.db that a version it can't upgrade made, which only starting over ends", async () => {
    const path = join(createTestFolder(), "bridge.db");
    await createDatabaseMadeBy(path, 1);

    await expect(openBridgeDatabase(path)).rejects.toThrow(
      `${path} was made by another version of toy-box-slack. The bridge has to start over, which forgets every link, so stop the bridge, remove bridge.db and its -wal/-shm files, and start it again. Then link each channel and allow its people again.`,
    );
  });

  test("refuses a bridge.db that a newer version made, sending the owner back to that version", async () => {
    const path = join(createTestFolder(), "bridge.db");
    await createDatabaseMadeBy(path, Math.max(...recordedVersions) + 1);

    await expect(openBridgeDatabase(path)).rejects.toThrow(
      `${path} was made by a newer version of toy-box-slack, which this one can't read. Install the newer version again and start the bridge.`,
    );
  });
});

describe("BridgeDatabase", () => {
  async function createProbe(database: BridgeDatabase): Promise<BridgeDatabase> {
    await database.write((transaction) => transaction`CREATE TABLE probe (id INTEGER PRIMARY KEY)`);
    return database;
  }

  function readRows(database: BridgeDatabase): Promise<number[]> {
    return database.read(async (sql) => {
      const rows = await sql<{ id: number }[]>`SELECT id FROM probe ORDER BY id`;
      return rows.map((row) => row.id);
    });
  }

  test("closes only after the work queued before it", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const database = await createProbe(await openBridgeDatabase(path));

    const write = database.write((transaction) => transaction`INSERT INTO probe (id) VALUES (1)`);
    await database.close();
    await write;

    await expect(readRows(database)).rejects.toThrow("Connection closed");
    expect(await readRows(await open(path))).toEqual([1]);
  });
});

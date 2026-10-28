import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "./database";
import { createTestFolder, openTestDatabase } from "./testFixtures";

async function open(path: string): Promise<BridgeDatabase> {
  const database = await openBridgeDatabase(path);
  onTestFinished(() => database.close());
  return database;
}

async function readSchema(sql: Bun.SQL) {
  const [{ user_version: version }] = await sql<{ user_version: number }[]>`PRAGMA user_version`;
  const objects = await sql<{ type: string; name: string; sql: string }[]>`
    SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `;
  return { version, objects: [...objects] };
}

describe("openBridgeDatabase", () => {
  test("runs with the settings that keep each commit through a power loss and references whole", async () => {
    const database = await openTestDatabase();

    const reported = await database.read(async (sql) => {
      const settings: Record<string, unknown> = {};
      for (const name of ["journal_mode", "synchronous", "fullfsync", "foreign_keys"]) {
        const [row] = await sql.unsafe<Record<string, unknown>[]>(`PRAGMA ${name}`);
        settings[name] = row?.[name];
      }
      return settings;
    });

    expect(reported).toEqual({
      journal_mode: "wal",
      synchronous: 2,
      fullfsync: 1,
      foreign_keys: 1,
    });
  });

  test("creates the tables in a new file once, so opening it again changes nothing", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const first = await openBridgeDatabase(path);
    const schema = await first.read(readSchema);
    await first.close();

    const second = await open(path);

    expect(schema).toMatchObject({ version: 1 });
    expect(await second.read(readSchema)).toEqual(schema);
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

  test("runs a read issued while a write is open after that write, outside its transaction", async () => {
    const database = await createProbe(await open(join(createTestFolder(), "bridge.db")));
    let markOpen!: () => void;
    let release!: () => void;
    const isOpen = new Promise<void>((resolve) => (markOpen = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const write = database.write(async (transaction) => {
      await transaction`INSERT INTO probe (id) VALUES (1)`;
      markOpen();
      await released;
      throw new Error("Rolled back.");
    });
    await isOpen;

    const read = readRows(database);
    await Bun.sleep(20);
    release();

    await expect(write).rejects.toThrow("Rolled back.");
    expect(await read).toEqual([]);
  });

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

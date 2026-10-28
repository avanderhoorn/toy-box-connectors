import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "./database";
import { createTestFolder, openTestDatabase } from "./testFixtures";

async function open(path: string): Promise<BridgeDatabase> {
  const database = await openBridgeDatabase(path);
  onTestFinished(() => database.close());
  return database;
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

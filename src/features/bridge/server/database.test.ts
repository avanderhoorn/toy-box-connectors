import { describe, expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openBridgeDatabase, unmetSettings, type BridgeDatabase, type Migration } from "./database";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder, openTestDatabase } from "./testFixtures";

async function open(path: string, migrations?: readonly Migration[]): Promise<BridgeDatabase> {
  const database = await openBridgeDatabase(path, migrations);
  onTestFinished(() => database.close());
  return database;
}

/** A migration that records that it ran and creates a table named after itself. */
function createTable(name: string, ran: string[]): Migration {
  return async (transaction) => {
    ran.push(name);
    await transaction.unsafe(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`);
  };
}

async function readSchema(sql: Bun.SQL) {
  const [{ user_version: version }] = await sql<{ user_version: number }[]>`PRAGMA user_version`;
  const objects = await sql<{ type: string; name: string; sql: string }[]>`
    SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `;
  return { version, objects: [...objects] };
}

async function readTableNames(sql: Bun.SQL): Promise<string[]> {
  const { objects } = await readSchema(sql);
  return objects.filter((object) => object.type === "table").map((object) => object.name);
}

describe("openBridgeDatabase", () => {
  test("runs with every setting SQLite reports back as required", async () => {
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

  test("creates every table and index in the data model on an empty file", async () => {
    const database = await openTestDatabase();

    const { version, objects } = await database.read(readSchema);

    expect(version).toBe(3);
    expect(
      objects.filter((object) => object.type === "table").map((object) => object.name),
    ).toEqual([
      "allowlist",
      "approvals",
      "audit",
      "changes",
      "channel_aliases",
      "channel_info",
      "claims",
      "coverage",
      "cursors",
      "files",
      "installation",
      "link_routines",
      "links",
      "messages",
      "outbox",
      "outbox_channels",
      "rate_limits",
      "receipts",
      "request_messages",
      "requests",
      "threads",
      "toybox_streams",
      "user_aliases",
      "users",
      "wake_state",
      "wakes",
    ]);
    expect(
      objects.filter((object) => object.type === "index").map((object) => object.name),
    ).toEqual([
      "claims_one_open",
      "files_message",
      "outbox_one_final",
      "outbox_one_publication",
      "receipts_received",
      "request_messages_one_request",
      "requests_one_active",
    ]);
  });

  test("leaves a current schema exactly as it was when the file is opened again", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const first = await openBridgeDatabase(path);
    const schema = await first.read(readSchema);
    await first.close();

    const second = await open(path);

    expect(await second.read(readSchema)).toEqual(schema);
  });

  test("runs only the migrations a file hasn't had, in order, and records its new version", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const ran: string[] = [];
    const migrations = [
      createTable("one", ran),
      createTable("two", ran),
      createTable("three", ran),
    ];
    await (await openBridgeDatabase(path, migrations.slice(0, 1))).close();

    const database = await open(path, migrations);

    expect(ran).toEqual(["one", "two", "three"]);
    expect(await database.read(readSchema)).toMatchObject({ version: 3 });
    expect(await database.read(readTableNames)).toEqual(["one", "three", "two"]);
  });

  test("rolls back a failed migration whole, including the version, so the next start retries it", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const ran: string[] = [];
    await (await openBridgeDatabase(path, [createTable("one", ran)])).close();
    const failing: Migration = async (transaction) => {
      await createTable("two", ran)(transaction);
      throw new Error("The disk is full.");
    };

    await expect(openBridgeDatabase(path, [createTable("one", ran), failing])).rejects.toThrow(
      "The disk is full.",
    );

    const database = await open(path, [createTable("one", ran)]);
    expect(await database.read(readSchema)).toMatchObject({ version: 1 });
    expect(await database.read(readTableNames)).toEqual(["one"]);
  });

  test("refuses a file from a newer toy-box-slack without changing it", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const ran: string[] = [];
    const newer = [createTable("one", ran), createTable("two", ran)];
    await (await openBridgeDatabase(path, newer)).close();

    const older = openBridgeDatabase(path, newer.slice(0, 1));

    await expect(older).rejects.toThrow(BridgeRefusedError);
    await expect(older).rejects.toThrow(
      `${path} has schema version 2, but this toy-box-slack knows only 1. Run the newer toy-box-slack that wrote it.`,
    );
    const database = await open(path, newer);
    expect(await database.read(readSchema)).toMatchObject({ version: 2 });
    expect(await database.read(readTableNames)).toEqual(["one", "two"]);
  });

  test("opens the exact file even when its path contains ? and #", async () => {
    const folder = join(createTestFolder(), "a?b#c");
    mkdirSync(folder);

    const database = await open(join(folder, "bridge.db"));

    expect(await database.read(readSchema)).toMatchObject({ version: 3 });
    expect(readdirSync(folder)).toContain("bridge.db");
    expect(existsSync(join(folder, "..", "a"))).toBe(false);
  });
});

describe("unmetSettings", () => {
  test("accepts the settings the bridge requires", () => {
    expect(
      unmetSettings({ journal_mode: "wal", synchronous: 2, fullfsync: 1, foreign_keys: 1 }),
    ).toEqual([]);
  });

  test("names every setting SQLite didn't apply", () => {
    expect(
      unmetSettings({ journal_mode: "delete", synchronous: 1, fullfsync: 0, foreign_keys: 1 }),
    ).toEqual([
      "journal_mode is delete, not wal",
      "synchronous is 1, not 2",
      "fullfsync is 0, not 1",
    ]);
    expect(unmetSettings({})).toHaveLength(4);
  });
});

describe("BridgeDatabase", () => {
  function readMethods(database: BridgeDatabase): Promise<string[]> {
    return database.read(async (sql) => {
      const rows = await sql<{ method: string }[]>`SELECT method FROM rate_limits ORDER BY method`;
      return rows.map((row) => row.method);
    });
  }

  test("runs a read issued while a write is open after that write, outside its transaction", async () => {
    const database = await openTestDatabase();
    let markOpen!: () => void;
    let release!: () => void;
    const isOpen = new Promise<void>((resolve) => (markOpen = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const write = database.write(async (transaction) => {
      await transaction`INSERT INTO rate_limits (method, next_attempt_at) VALUES ('chat.postMessage', 1)`;
      markOpen();
      await released;
      throw new Error("Rolled back.");
    });
    await isOpen;

    const read = readMethods(database);
    await Bun.sleep(20);
    release();

    await expect(write).rejects.toThrow("Rolled back.");
    expect(await read).toEqual([]);
  });

  test("closes only after the work queued before it", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const database = await openBridgeDatabase(path);

    const write = database.write(
      (transaction) =>
        transaction`INSERT INTO rate_limits (method, next_attempt_at) VALUES ('chat.postMessage', 1)`,
    );
    await database.close();
    await write;

    await expect(readMethods(database)).rejects.toThrow("Connection closed");
    expect(await readMethods(await open(path))).toEqual(["chat.postMessage"]);
  });
});

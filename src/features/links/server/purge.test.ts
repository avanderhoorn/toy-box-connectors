import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import { sweepFiles, uninstallPurge } from "./purge";

function writeFiles(folder: string, paths: readonly string[]) {
  for (const path of paths) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), "copy");
  }
}

function storeFetchedFiles(database: BridgeDatabase, paths: readonly string[]) {
  return database.write(async (transaction) => {
    for (const [index, path] of paths.entries()) {
      await transaction`
        INSERT INTO files (file_id, channel_id, ts, state, local_path, fetched_at)
        VALUES (${`F-${index}`}, 'C-link', '1700000100.000100', 'fetched', ${path}, 0)
      `;
    }
  });
}

describe("what each purge does", () => {
  test("uninstalling decides the fate of every table", async () => {
    const database = await openTestDatabase();

    const tables = await database.read(
      (sql) => sql<{ name: string }[]>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `,
    );

    expect(Object.keys(uninstallPurge).sort()).toEqual(tables.map((table) => table.name));
  });
});

describe("sweeping the files folder", () => {
  test("removes every file no row names, at any depth, and keeps the ones rows name", async () => {
    const database = await openTestDatabase();
    const folder = createTestFolder();
    writeFiles(folder, ["F-0/report.pdf", "F-1/deep/notes.txt", "F-2/partial.bin", "stray.txt"]);
    await storeFetchedFiles(database, ["F-0/report.pdf", "./F-1/deep/notes.txt"]);

    await sweepFiles(database, folder);

    expect(existsSync(join(folder, "F-0/report.pdf"))).toBe(true);
    expect(existsSync(join(folder, "F-1/deep/notes.txt"))).toBe(true);
    expect(existsSync(join(folder, "F-2/partial.bin"))).toBe(false);
    expect(existsSync(join(folder, "stray.txt"))).toBe(false);
  });

  test("removes a link no row names without following it", async () => {
    const database = await openTestDatabase();
    const folder = createTestFolder();
    const outside = createTestFolder();
    writeFiles(outside, ["kept/secret.txt"]);
    mkdirSync(join(folder, "F-0"));
    symlinkSync(join(outside, "kept"), join(folder, "F-0/linked"));

    await sweepFiles(database, folder);

    expect(existsSync(join(folder, "F-0/linked"))).toBe(false);
    expect(existsSync(join(outside, "kept/secret.txt"))).toBe(true);
  });

  test("a files folder that doesn't exist yet holds nothing to remove", async () => {
    const database = await openTestDatabase();

    await sweepFiles(database, join(createTestFolder(), "files"));
  });
});

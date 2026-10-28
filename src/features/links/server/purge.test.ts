import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import { pendingApproval } from "@links/model/testFixtures";
import { queueItem } from "@outbox/server/database";
import { recordGap } from "@activity/server/coverage";
import { createApproval } from "./approvals";
import { purgeForReset, purgeForUninstall, resetPurge, sweepFiles, uninstallPurge } from "./purge";
import { countRows, createStoredLink, fillEveryTable } from "./testFixtures";

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

/** Every table the schema has, SQLite's own aside, by name. */
async function readTableNames(database: BridgeDatabase): Promise<string[]> {
  const tables = await database.read(
    (sql) => sql<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
  );
  return tables.map((table) => table.name);
}

/**
 * Stores an outbox item, an approval with its card and a gap in a new link's channel, and returns
 * the numbers they got.
 */
async function createNumbered(database: BridgeDatabase) {
  await createStoredLink(database);
  return database.write(async (transaction) => {
    const item = await queueItem(
      transaction,
      { kind: "progress", channelId: "C-link", payload: {} },
      60_000,
    );
    const approval = await createApproval(
      transaction,
      {
        toyboxChannelId: "toybox-link",
        linkId: "link",
        action: "allow",
        patch: [{ field: "allowlist.U-carol", after: { label: null } }],
        readSet: pendingApproval().readSet,
        cardChannelId: "C-link",
        createdBy: "lead",
      },
      60_000,
    );
    await recordGap(
      transaction,
      {
        linkId: "link",
        channelId: "C-link",
        threadTs: null,
        window: { oldestTs: "1700000000.000100", latestTs: "1700000600.000200" },
        reason: "disconnect",
      },
      60_000,
    );
    const [gap] = await transaction<{ id: number }[]>`SELECT MAX(id) AS id FROM coverage`;
    const [card] = await transaction<{ number: number }[]>`
      SELECT number FROM outbox WHERE approval_id = ${approval.id}
    `;
    return { item: item.number, approval: approval.number, card: card!.number, gap: gap!.id };
  });
}

describe("what each purge does", () => {
  test("uninstalling decides the fate of every table", async () => {
    const database = await openTestDatabase();

    expect(Object.keys(uninstallPurge).sort()).toEqual(await readTableNames(database));
  });

  test("resetting decides the fate of every table", async () => {
    const database = await openTestDatabase();

    expect(Object.keys(resetPurge).sort()).toEqual(await readTableNames(database));
  });

  test("no outbox item, approval or gap takes a number one had before a purge", async () => {
    const database = await openTestDatabase();
    expect(await createNumbered(database)).toEqual({ item: 1, approval: 1, card: 2, gap: 1 });

    await database.write((transaction) => purgeForUninstall(transaction, 120_000));
    expect(await createNumbered(database)).toEqual({ item: 3, approval: 2, card: 4, gap: 2 });

    await database.write((transaction) => purgeForReset(transaction, 180_000));
    expect(await createNumbered(database)).toEqual({ item: 5, approval: 3, card: 6, gap: 3 });
  });
});

describe("resetting", () => {
  test("purges every row, the installation and its owner too, but keeps the audit log", async () => {
    const database = await openTestDatabase();
    await fillEveryTable(database);

    const copies = await database.write((transaction) => purgeForReset(transaction, 60_000));

    expect(copies).toEqual(["F-kept/report.pdf"]);
    const after = await countRows(database);
    expect(Object.keys(after).filter((table) => after[table] !== 0)).toEqual(["audit"]);
    expect(
      await database.read(
        (sql) =>
          sql`SELECT at, actor, action, link_id, approval_id, subject FROM audit ORDER BY id`,
      ),
    ).toEqual([
      {
        at: 1_000,
        actor: "owner",
        action: "approve",
        link_id: null,
        approval_id: null,
        subject: "U-owner",
      },
      {
        at: 60_000,
        actor: "operator",
        action: "reset",
        link_id: null,
        approval_id: null,
        subject: null,
      },
    ]);
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

  test("a files folder that can't be read rejects", async () => {
    const database = await openTestDatabase();
    const folder = join(createTestFolder(), "files");
    writeFileSync(folder, "not a folder");

    await expect(sweepFiles(database, folder)).rejects.toThrow("ENOTDIR");
  });
});

import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { recordUninstall, suspendChannelLinks } from "./lifecycle";
import { countRows, createStoredLink, fillEveryTable } from "./testFixtures";

function readLinks(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`);
}

describe("a lifecycle signal about a linked channel", () => {
  test("a channel made public suspends the link once, and only if the owner approved it private", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "private");
    await createStoredLink(database, "public", {
      approved_audience: { ...privateAudience(), kind: "public" },
    });

    const suspend = (channelId: string) =>
      database.write((transaction) =>
        suspendChannelLinks(transaction, channelId, "channel_made_public", 60_000),
      );
    expect(await suspend("C-private")).toEqual(["private"]);
    expect(await suspend("C-public")).toEqual([]);
    expect(await suspend("C-private")).toEqual([]);

    expect(await readLinks(database)).toEqual([
      { id: "private", status: "suspended", status_reason: "channel_made_public" },
      { id: "public", status: "active", status_reason: null },
    ]);
  });
});

describe("uninstalling the app", () => {
  test("deletes every row but the installation", async () => {
    const database = await openTestDatabase();
    await fillEveryTable(database);
    const before = await countRows(database);
    expect(Object.keys(before).filter((table) => before[table] === 0)).toEqual([]);

    await database.write(recordUninstall);

    const after = await countRows(database);
    expect(Object.keys(after).filter((table) => after[table] !== 0)).toEqual(["installation"]);
    expect(await database.read((sql) => sql`SELECT team_id, status FROM installation`)).toEqual([
      { team_id: "T-home", status: "uninstalled" },
    ]);
  });
});

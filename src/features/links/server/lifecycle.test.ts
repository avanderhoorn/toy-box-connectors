import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { readChannelInfo, writeChannelInfo } from "@slackapi/server/channels";
import { recordUninstall, suspendChannelLinks } from "./lifecycle";
import { countRows, createStoredLink, fillEveryTable } from "./testFixtures";

function readLinks(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`);
}

describe("a lifecycle signal about a linked channel", () => {
  test("suspends the channel's link and casts doubt on what's stored about it", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredLink(database, "other");
    await database.write((transaction) => writeChannelInfo(transaction, channelFacts(), 1_000));

    const changed = await database.write((transaction) =>
      suspendChannelLinks(transaction, "C-link", "bot_removed", 60_000),
    );

    expect(changed).toEqual(["link"]);
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "bot_removed" },
      { id: "other", status: "active", status_reason: null },
    ]);
    expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toMatchObject({
      invalidatedAt: 60_000,
    });
  });

  test("a channel made public suspends the link only if the owner approved it private", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "private");
    await createStoredLink(database, "public", {
      approved_audience: { ...privateAudience(), kind: "public" },
    });

    for (const channelId of ["C-private", "C-public"]) {
      await database.write((transaction) =>
        suspendChannelLinks(transaction, channelId, "channel_made_public", 60_000),
      );
    }

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

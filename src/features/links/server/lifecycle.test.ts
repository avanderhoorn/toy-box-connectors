import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { readChannelInfo, writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { changeChannelId, recordUninstall, suspendChannelLinks } from "./lifecycle";
import { countRows, createStoredApproval, createStoredLink, fillEveryTable } from "./testFixtures";

type LinkRow = {
  id: string;
  slack_channel_id: string;
  publish_channel_id: string;
  status: string;
  status_reason: string | null;
};

async function readLinks(database: BridgeDatabase): Promise<LinkRow[]> {
  const links = await database.read(
    (sql) => sql<LinkRow[]>`
      SELECT id, slack_channel_id, publish_channel_id, status, status_reason FROM links ORDER BY id
    `,
  );
  return [...links];
}

function readInvalidatedAt(database: BridgeDatabase, channelId: string) {
  return database.read(async (sql) => (await readChannelInfo(sql, channelId))?.invalidatedAt);
}

function storeChannelInfo(database: BridgeDatabase, channelId: string) {
  return database.write((transaction) =>
    writeChannelInfo(transaction, channelFacts({ id: channelId }), 1_000),
  );
}

describe("a lifecycle signal about a linked channel", () => {
  test("suspends each link that watches the channel or publishes to it, and casts doubt on it", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "watches", {
      slack_channel_id: "C-signal",
      publish_channel_id: "C-own",
    });
    await createStoredLink(database, "publishes", { publish_channel_id: "C-signal" });
    await createStoredLink(database, "elsewhere");
    await storeChannelInfo(database, "C-signal");

    const changed = await database.write((transaction) =>
      suspendChannelLinks(transaction, "C-signal", "bot_removed", 60_000),
    );

    expect(changed).toEqual(["publishes", "watches"]);
    expect(await readLinks(database)).toEqual([
      {
        id: "elsewhere",
        slack_channel_id: "C-elsewhere",
        publish_channel_id: "C-elsewhere",
        status: "active",
        status_reason: null,
      },
      {
        id: "publishes",
        slack_channel_id: "C-publishes",
        publish_channel_id: "C-signal",
        status: "suspended",
        status_reason: "bot_removed",
      },
      {
        id: "watches",
        slack_channel_id: "C-signal",
        publish_channel_id: "C-own",
        status: "suspended",
        status_reason: "bot_removed",
      },
    ]);
    expect(await readInvalidatedAt(database, "C-signal")).toBe(60_000);
  });

  test("a channel made public suspends only the links the owner approved it private for", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "approved-private", { slack_channel_id: "C-signal" });
    await createStoredLink(database, "approved-public", {
      publish_channel_id: "C-signal",
      approved_audience: {
        monitored: privateAudience("C-approved-public"),
        publish: { ...privateAudience("C-signal"), kind: "public" },
      },
    });

    const changed = await database.write((transaction) =>
      suspendChannelLinks(transaction, "C-signal", "channel_made_public", 60_000),
    );

    expect(changed).toEqual(["approved-private"]);
    expect((await readLinks(database)).map((link) => link.status)).toEqual(["suspended", "active"]);
  });

  test("a signal delivered again changes nothing", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await database.write((transaction) =>
      suspendChannelLinks(transaction, "C-link", "channel_archived", 60_000),
    );

    const changed = await database.write((transaction) =>
      suspendChannelLinks(transaction, "C-link", "channel_archived", 120_000),
    );

    expect(changed).toEqual([]);
  });
});

describe("a channel's new ID", () => {
  test("moves every link, card, claim and outbox item to it, and suspends the links using it", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredLink(database, "publishes", { publish_channel_id: "C-link" });
    await createStoredLink(database, "elsewhere");
    await createStoredApproval(database);
    await createStoredApproval(database, {
      id: "elsewhere-card",
      number: 2,
      linkId: "elsewhere",
      toyboxChannelId: "toybox-elsewhere",
    });
    await database.write(
      (transaction) => transaction`
        INSERT INTO claims (code_hash, state, created_at, expires_at, posted_by, posted_channel_id,
          posted_ts, posted_at, decided_at)
        VALUES ('hash', 'confirmed', 0, 600_000, 'U-owner', 'C-link', '1000.000200', 0, 0)
      `,
    );
    await createStoredOutboxItem(database, 1);
    await storeChannelInfo(database, "C-link");
    await storeChannelInfo(database, "C-new");

    const changed = await database.write((transaction) =>
      changeChannelId(transaction, "C-link", "C-new", 60_000),
    );

    expect(changed).toEqual(["link", "publishes"]);
    expect(await readLinks(database)).toEqual([
      {
        id: "elsewhere",
        slack_channel_id: "C-elsewhere",
        publish_channel_id: "C-elsewhere",
        status: "active",
        status_reason: null,
      },
      {
        id: "link",
        slack_channel_id: "C-new",
        publish_channel_id: "C-new",
        status: "suspended",
        status_reason: "channel_id_changed",
      },
      {
        id: "publishes",
        slack_channel_id: "C-publishes",
        publish_channel_id: "C-new",
        status: "suspended",
        status_reason: "channel_id_changed",
      },
    ]);
    expect(
      await database.read(
        (sql) => sql`SELECT id, card_channel_id, state FROM approvals ORDER BY number`,
      ),
    ).toEqual([
      { id: "approval-1", card_channel_id: "C-new", state: "stale" },
      { id: "elsewhere-card", card_channel_id: "C-new", state: "pending" },
    ]);
    expect(await database.read((sql) => sql`SELECT posted_channel_id FROM claims`)).toEqual([
      { posted_channel_id: "C-new" },
    ]);
    // The card update the suspension queued goes to where the card is now.
    expect(
      await database.read(
        (sql) => sql`SELECT number, kind, channel_id FROM outbox ORDER BY number`,
      ),
    ).toEqual([
      { number: 1, kind: "reply", channel_id: "C-new" },
      { number: 2, kind: "card", channel_id: "C-new" },
    ]);
    expect(await database.read((sql) => sql`SELECT * FROM channel_aliases`)).toEqual([
      { old_id: "C-link", channel_id: "C-new", changed_at: 60_000 },
    ]);
    expect(await readInvalidatedAt(database, "C-link")).toBe(60_000);
    expect(await readInvalidatedAt(database, "C-new")).toBe(60_000);
  });

  test("an ID that didn't change changes nothing", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    const changed = await database.write((transaction) =>
      changeChannelId(transaction, "C-link", "C-link", 60_000),
    );

    expect(changed).toEqual([]);
    expect((await readLinks(database))[0]?.status).toBe("active");
    expect(await database.read((sql) => sql`SELECT * FROM channel_aliases`)).toEqual([]);
  });
});

describe("uninstalling the app", () => {
  test("purges every row but the installation and the record of the purge", async () => {
    const database = await openTestDatabase();
    await fillEveryTable(database);
    const before = await countRows(database);
    expect(Object.keys(before).filter((table) => before[table] === 0)).toEqual([]);

    const copies = await database.write((transaction) => recordUninstall(transaction, 60_000));

    expect(copies).toEqual(["F-kept/report.pdf"]);
    const after = await countRows(database);
    expect(Object.keys(after).filter((table) => after[table] !== 0)).toEqual([
      "audit",
      "installation",
    ]);
    expect(
      await database.read((sql) => sql`SELECT at, actor, action, link_id, subject FROM audit`),
    ).toEqual([
      { at: 60_000, actor: "bridge", action: "purge", link_id: null, subject: "uninstalled" },
    ]);
    expect(
      await database.read((sql) => sql`SELECT team_id, owner_user_id, status FROM installation`),
    ).toEqual([{ team_id: "T-home", owner_user_id: null, status: "uninstalled" }]);
  });

  test("an installation whose token was already failing is purged too", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database, { status: "auth_failed" });
    await createStoredLink(database);

    await database.write((transaction) => recordUninstall(transaction, 60_000));

    expect(await readLinks(database)).toEqual([]);
    expect(await database.read((sql) => sql`SELECT status FROM installation`)).toEqual([
      { status: "uninstalled" },
    ]);
  });

  test("a second signal purges nothing more and records nothing more", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await database.write((transaction) => recordUninstall(transaction, 60_000));

    const copies = await database.write((transaction) => recordUninstall(transaction, 120_000));

    expect(copies).toEqual([]);
    expect(await database.read((sql) => sql`SELECT at, action FROM audit`)).toEqual([
      { at: 60_000, action: "purge" },
    ]);
  });
});

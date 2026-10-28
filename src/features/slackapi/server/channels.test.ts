import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import {
  currentChannelId,
  invalidateChannelInfo,
  readChannelInfo,
  recordChannelAlias,
  writeChannelInfo,
} from "./channels";

test("a channel's facts read back as they were written, with when they were read", async () => {
  const database = await openTestDatabase();
  const shared = channelFacts({ id: "C-shared", kind: "public", name: null, isOrgShared: true });
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 1_000);
    await writeChannelInfo(transaction, shared, 2_000);
  });

  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
    facts: channelFacts(),
    refreshedAt: 1_000,
    invalidatedAt: null,
  });
  expect(await database.read((sql) => readChannelInfo(sql, "C-shared"))).toEqual({
    facts: shared,
    refreshedAt: 2_000,
    invalidatedAt: null,
  });
  expect(await database.read((sql) => readChannelInfo(sql, "C-unread"))).toBeNull();
});

test("a later read replaces every fact", async () => {
  const database = await openTestDatabase();
  const changed = channelFacts({
    name: "renamed",
    kind: "mpim",
    isMember: false,
    isArchived: true,
    isExtShared: true,
    isPendingExtShared: true,
    isOrgShared: true,
    enterpriseId: "E-org",
    contextTeamId: "T-sibling",
    sharedTeamIds: ["T-home", "T-sibling"],
  });
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 1_000);
    await writeChannelInfo(transaction, changed, 2_000);
  });

  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
    facts: changed,
    refreshedAt: 2_000,
    invalidatedAt: null,
  });
});

test("invalidating a channel keeps its facts and marks them with the latest signal", async () => {
  const database = await openTestDatabase();
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 1_000);
    await invalidateChannelInfo(transaction, "C-link", 3_000);
    await invalidateChannelInfo(transaction, "C-link", 2_000);
  });
  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
    facts: channelFacts(),
    refreshedAt: 1_000,
    invalidatedAt: 3_000,
  });

  await database.write((transaction) => invalidateChannelInfo(transaction, "C-link", 4_000));
  const info = await database.read((sql) => readChannelInfo(sql, "C-link"));
  expect(info?.invalidatedAt).toBe(4_000);
});

test("invalidating a channel the bridge never read stores nothing", async () => {
  const database = await openTestDatabase();
  await database.write((transaction) => invalidateChannelInfo(transaction, "C-unread", 1_000));

  expect(await database.read((sql) => readChannelInfo(sql, "C-unread"))).toBeNull();
});

test("a read that began after the latest signal replaces the facts and clears it", async () => {
  const database = await openTestDatabase();
  const archived = channelFacts({ isArchived: true });
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 1_000);
    await invalidateChannelInfo(transaction, "C-link", 2_000);
    await writeChannelInfo(transaction, archived, 2_001);
  });

  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
    facts: archived,
    refreshedAt: 2_001,
    invalidatedAt: null,
  });
});

test("a signal that lands while a read is under way outlives what the read returns", async () => {
  const database = await openTestDatabase();
  const reread = channelFacts({ name: "renamed" });
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 1_000);
    // The read began at 2_000, and channel_shared arrived before it returned.
    await invalidateChannelInfo(transaction, "C-link", 2_500);
    await writeChannelInfo(transaction, reread, 2_000);
  });
  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
    facts: reread,
    refreshedAt: 2_000,
    invalidatedAt: 2_500,
  });

  // A signal in the same millisecond a read began may have come after it.
  await database.write(async (transaction) => {
    await invalidateChannelInfo(transaction, "C-link", 3_000);
    await writeChannelInfo(transaction, reread, 3_000);
  });
  const info = await database.read((sql) => readChannelInfo(sql, "C-link"));
  expect(info).toMatchObject({ refreshedAt: 3_000, invalidatedAt: 3_000 });
});

test("a read that began before the stored one never replaces it", async () => {
  const database = await openTestDatabase();
  const older = channelFacts({ isExtShared: true });
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 2_000);
    await writeChannelInfo(transaction, older, 1_000);
  });

  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
    facts: channelFacts(),
    refreshedAt: 2_000,
    invalidatedAt: null,
  });
});

test("each alias names the channel's current ID, however many times it moves", async () => {
  const database = await openTestDatabase();
  const readAliases = () =>
    database.read((sql) => sql`SELECT * FROM channel_aliases ORDER BY old_id`);

  await database.write((transaction) => recordChannelAlias(transaction, "C-1", "C-2", 1_000));
  await database.write((transaction) => recordChannelAlias(transaction, "C-2", "C-3", 2_000));
  expect(await readAliases()).toEqual([
    { old_id: "C-1", channel_id: "C-3", changed_at: 1_000 },
    { old_id: "C-2", channel_id: "C-3", changed_at: 2_000 },
  ]);

  // Moved back to an ID it had, the channel answers to it again.
  await database.write((transaction) => recordChannelAlias(transaction, "C-3", "C-1", 3_000));
  expect(await readAliases()).toEqual([
    { old_id: "C-2", channel_id: "C-1", changed_at: 2_000 },
    { old_id: "C-3", channel_id: "C-1", changed_at: 3_000 },
  ]);
});

test("a channel named by an ID it moved from is the channel at its current ID", async () => {
  const database = await openTestDatabase();
  await database.write(async (transaction) => {
    await recordChannelAlias(transaction, "C-1", "C-2", 1_000);
    await recordChannelAlias(transaction, "C-2", "C-3", 2_000);
  });

  await database.read(async (sql) => {
    expect(await currentChannelId(sql, "C-1")).toBe("C-3");
    expect(await currentChannelId(sql, "C-2")).toBe("C-3");
    expect(await currentChannelId(sql, "C-3")).toBe("C-3");
    expect(await currentChannelId(sql, "C-never")).toBe("C-never");
  });
});

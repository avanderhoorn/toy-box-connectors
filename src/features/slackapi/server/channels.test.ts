import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { invalidateChannelInfo, readChannelInfo, writeChannelInfo } from "./channels";

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

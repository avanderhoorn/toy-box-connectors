import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelFacts } from "@slackapi/model/channels";
import { channelFacts } from "@slackapi/model/testFixtures";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { judgeChannelLink } from "./audience";
import { createStoredLink } from "./testFixtures";

test("a fresh read wider than the owner approved suspends the channel's link", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database);

  await database.write((transaction) =>
    judgeChannelLink(transaction, "C-link", channelFacts({ kind: "public" }), 60_000),
  );

  expect(await database.read((sql) => sql`SELECT status, status_reason FROM links`)).toEqual([
    { status: "suspended", status_reason: "channel_made_public" },
  ]);
});

test("a fresh read that names the channel anew renames the link's channel, even as it suspends the link", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database, "link", { slack_channel_name: "old-name" });
  const read = (facts: ChannelFacts | null) =>
    database.write((transaction) => judgeChannelLink(transaction, "C-link", facts, 60_000));
  const stored = () => database.read((sql) => sql`SELECT slack_channel_name AS name FROM links`);

  await read(channelFacts({ name: "new-name" }));
  expect(await stored()).toEqual([{ name: "new-name" }]);

  await read(null);
  expect(await stored()).toEqual([{ name: "new-name" }]);

  await read(channelFacts({ name: "wider-name", kind: "public" }));
  expect(await stored()).toEqual([{ name: "wider-name" }]);
});

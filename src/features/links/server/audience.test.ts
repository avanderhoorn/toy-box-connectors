import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
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

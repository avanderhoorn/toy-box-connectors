import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import type { ChannelFacts } from "@slackapi/model/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { judgeChannelLinks } from "./audience";
import { createStoredLink } from "./testFixtures";

function judge(database: BridgeDatabase, channelId: string, facts: ChannelFacts | null) {
  return database.write((transaction) => judgeChannelLinks(transaction, channelId, facts, 60_000));
}

function readStatuses(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`);
}

describe("judging a fresh read of a linked channel", () => {
  test("a read no wider than approved keeps every link that uses the channel", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await createStoredLink(database);

    const verdicts = await judge(database, "C-link", channelFacts({ name: "renamed" }));

    expect(verdicts).toEqual(new Map([["link", { kind: "approved" }]]));
    expect(await readStatuses(database)).toEqual([
      { id: "link", status: "active", status_reason: null },
    ]);
  });

  test("a widened audience suspends the link", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await createStoredLink(database);

    const verdicts = await judge(database, "C-link", channelFacts({ isPendingExtShared: true }));

    expect(verdicts).toEqual(
      new Map([["link", { kind: "suspended", reason: "channel_external" }]]),
    );
    expect(await readStatuses(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "channel_external" },
    ]);
  });

  test("a channel Slack can't find suspends every link that uses it", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await createStoredLink(database, "publishes", { publish_channel_id: "C-link" });

    await judge(database, "C-link", null);

    expect(await readStatuses(database)).toEqual([
      { id: "publishes", status: "suspended", status_reason: "channel_not_found" },
    ]);
  });

  test("each link is judged against what the owner approved for the role it uses the channel in", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await createStoredLink(database, "approved-private", { slack_channel_id: "C-shared" });
    await createStoredLink(database, "approved-public", {
      publish_channel_id: "C-shared",
      approved_audience: {
        monitored: privateAudience("C-approved-public"),
        publish: { ...privateAudience("C-shared"), kind: "public" },
      },
    });

    const verdicts = await judge(
      database,
      "C-shared",
      channelFacts({ id: "C-shared", kind: "public" }),
    );

    expect(verdicts).toEqual(
      new Map([
        ["approved-private", { kind: "suspended", reason: "channel_made_public" }],
        ["approved-public", { kind: "approved" }],
      ]),
    );
    expect(await readStatuses(database)).toEqual([
      { id: "approved-private", status: "suspended", status_reason: "channel_made_public" },
      { id: "approved-public", status: "active", status_reason: null },
    ]);
  });

  test("a read that holds posts leaves the link's status as it was", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database, { enterprise_id: "E-org" });
    const orgShared = {
      ...privateAudience(),
      orgShared: true,
      enterpriseId: "E-org",
      workspaces: ["T-home", "T-sibling"],
    };
    await createStoredLink(database, "link", {
      approved_audience: { monitored: orgShared, publish: orgShared },
    });

    const verdicts = await judge(
      database,
      "C-link",
      channelFacts({ isOrgShared: true, enterpriseId: "E-org", sharedTeamIds: [] }),
    );

    expect(verdicts).toEqual(new Map([["link", { kind: "held", reason: "workspaces_unknown" }]]));
    expect(await readStatuses(database)).toEqual([
      { id: "link", status: "active", status_reason: null },
    ]);
  });

  test("without an installation there's nothing to judge against", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);

    expect(await judge(database, "C-link", null)).toEqual(new Map());
    expect(await readStatuses(database)).toEqual([
      { id: "link", status: "active", status_reason: null },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelFacts } from "@slackapi/model/channels";
import { channelFacts } from "@slackapi/model/testFixtures";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { judgeChannelLink } from "./audience";
import { createStoredLink } from "./testFixtures";

async function judge(facts: ChannelFacts | null) {
  const database: BridgeDatabase = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database);
  const verdict = await database.write((transaction) =>
    judgeChannelLink(transaction, "C-link", facts, 60_000),
  );
  const links = await database.read((sql) => sql`SELECT status, status_reason FROM links`);
  return { verdict, links: [...links] };
}

describe("judging a fresh read of a linked channel", () => {
  test("a read no wider than the owner approved keeps the link", async () => {
    expect(await judge(channelFacts({ name: "renamed" }))).toEqual({
      verdict: { kind: "approved" },
      links: [{ status: "active", status_reason: null }],
    });
  });

  test("a wider one suspends it", async () => {
    expect(await judge(channelFacts({ kind: "public" }))).toEqual({
      verdict: { kind: "suspended", reason: "channel_made_public" },
      links: [{ status: "suspended", status_reason: "channel_made_public" }],
    });
  });
});

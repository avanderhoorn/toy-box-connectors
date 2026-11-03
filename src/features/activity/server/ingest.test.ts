import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessageEvent } from "@slackapi/model/messages";
import { askMessage } from "@slackapi/model/testFixtures";
import { ingestMessageEvent } from "./ingest";

const ask = askMessage();

/** The link `createStoredLink` stores, allowing the owner, who Slack also names as W-owner. */
async function openIngest(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await database.write(async (transaction) => {
    await transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)
    `;
    await transaction`INSERT INTO users (user_id) VALUES ('U-owner')`;
    await transaction`INSERT INTO user_aliases (alias_id, user_id) VALUES ('W-owner', 'U-owner')`;
  });
  return database;
}

function ingest(database: BridgeDatabase, event: SlackMessageEvent) {
  return database.write((transaction) => ingestMessageEvent(transaction, event, 1_700_001_000_000));
}

test("only a linked channel's messages are stored, under their authors' own IDs, and a delete cancels the request it asked", async () => {
  const database = await openIngest();
  const elsewhere = askMessage("1700000200.000100", { channelId: "C-other" });
  expect(await ingest(database, { kind: "message", message: elsewhere })).toBe(false);
  const aliased = { ...ask, userId: "W-owner" };
  expect(await ingest(database, { kind: "message", message: aliased })).toBe(true);
  expect(await database.read((sql) => sql`SELECT user_id FROM messages`)).toEqual([
    { user_id: "U-owner" },
  ]);
  expect(await ingest(database, { kind: "replied" })).toBe(false);
  expect(await ingest(database, { kind: "deleted", channelId: "C-link", ts: ask.ts })).toBe(true);

  expect(
    await database.read(async (sql) => ({
      messages: await sql`SELECT channel_id, user_id, author_role, deleted FROM messages`,
      requests: await sql`SELECT requester_user_id, state, closed_reason FROM requests`,
    })),
  ).toEqual({
    messages: [{ channel_id: "C-link", user_id: null, author_role: "allowed", deleted: 1 }],
    requests: [
      { requester_user_id: "U-owner", state: "cancelled", closed_reason: "source_deleted" },
    ],
  });
});

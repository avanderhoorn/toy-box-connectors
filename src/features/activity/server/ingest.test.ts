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
    await transaction`INSERT INTO user_aliases (alias_id, user_id) VALUES ('W-owner', 'U-owner')`;
  });
  return database;
}

function ingest(database: BridgeDatabase, event: SlackMessageEvent) {
  return database.write((transaction) => ingestMessageEvent(transaction, event, 1_700_001_000_000));
}

function readStored(database: BridgeDatabase) {
  return database.read(async (sql) => ({
    messages: await sql`SELECT channel_id, user_id, author_role, deleted FROM messages`,
    requests: await sql`SELECT requester_user_id, state, closed_reason FROM requests`,
  }));
}

test("only a linked channel's messages are stored, each under its author's own ID", async () => {
  const database = await openIngest();
  const elsewhere = askMessage("1700000200.000100", { channelId: "C-other" });
  expect(await ingest(database, { kind: "message", message: elsewhere, edit: false })).toBe(false);
  const aliased = { ...ask, userId: "W-owner" };
  expect(await ingest(database, { kind: "message", message: aliased, edit: false })).toBe(true);
  expect(
    await ingest(database, {
      kind: "replied",
      channelId: "C-link",
      threadTs: ask.ts,
      latestReplyTs: null,
    }),
  ).toBe(false);

  expect(await readStored(database)).toEqual({
    messages: [{ channel_id: "C-link", user_id: "U-owner", author_role: "allowed", deleted: 0 }],
    requests: [{ requester_user_id: "U-owner", state: "open", closed_reason: null }],
  });
});

test("Slack withdrawing a message stores it as deleted, which cancels the request it asked", async () => {
  const database = await openIngest();
  await ingest(database, { kind: "message", message: ask, edit: false });
  expect(await ingest(database, { kind: "withdrawn", channelId: "C-link", ts: ask.ts })).toBe(true);

  expect(await readStored(database)).toEqual({
    messages: [{ channel_id: "C-link", user_id: "U-owner", author_role: "allowed", deleted: 1 }],
    requests: [
      { requester_user_id: "U-owner", state: "cancelled", closed_reason: "source_deleted" },
    ],
  });
});

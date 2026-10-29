import { expect, test } from "bun:test";
import { storeDelete, storeMessage } from "@activity/server/ledger";
import { linkAudience } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { readChannelLink } from "@links/server/database";
import { createStoredLink } from "@links/server/testFixtures";
import { beginAnswer, confirmAnswer, serveRequest } from "@requests/model/lifecycle";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import type { SlackTs } from "@slackapi/model/ts";
import { readMessageRequest, readRequest, saveRequest } from "./database";
import { takeDelete, takeMessage } from "./intake";

const now = 1_700_001_000_000;

const ask = askMessage();
const more = replyMessage(ask, "1700000200.000100");
const theirs = replyMessage(ask, "1700000250.000100", { userId: "U-allowed", mentionsBot: true });

/** A database whose link took the owner's `ask`, which opened request 1, and then `messages`. */
async function openIntake(...messages: SlackMessage[]): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  for (const message of [ask, ...messages]) await take(database, message);
  return database;
}

/** Stores `message` in the ledger and takes it, in one transaction as ingest does. */
function take(database: BridgeDatabase, message: SlackMessage) {
  return database.write(async (transaction) => {
    const link = (await readChannelLink(transaction, message.channelId))!;
    const stored = await storeMessage(transaction, linkAudience(), message, false);
    return takeMessage(transaction, link, message, stored, now);
  });
}

function takeDeleteOf(database: BridgeDatabase, { channelId, ts }: SlackMessage) {
  return database.write(async (transaction) => {
    await storeDelete(transaction, channelId, ts);
    return takeDelete(transaction, channelId, ts, now);
  });
}

function requestOf(database: BridgeDatabase, { channelId, ts }: SlackMessage) {
  return database.read((sql) => readMessageRequest(sql, channelId, ts));
}

/** Has the lead read request 1 and take it as far as `state`, with the outbox's help. */
function advance(database: BridgeDatabase, state: "seen" | "answering" | "answered") {
  return database.write(async (transaction) => {
    let request = serveRequest((await readRequest(transaction, 1))!, now);
    if (state !== "seen") request = beginAnswer(request, now);
    if (state === "answered") request = confirmAnswer(request);
    await saveRequest(transaction, request);
  });
}

test("a mention opens a request that holds its message, and a redelivery asks nothing new", async () => {
  const database = await openIntake();
  expect(await requestOf(database, ask)).toMatchObject({ id: 1, state: "open", reason: "mention" });
  expect(await take(database, ask)).toBe(false);
  expect(await take(database, editMessage(ask, "1700000150.000100", ask.text))).toBe(false);
});

test("the requester's later messages join their request and flag it once the lead read it", async () => {
  const database = await openIntake();
  await advance(database, "seen");
  expect(await take(database, more)).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ id: 1, attention: "updated" });
  await advance(database, "seen");
  expect(await take(database, editMessage(more, "1700000300.000100", "the seed step"))).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ state: "seen", attention: "updated" });
  await advance(database, "seen");
  expect(await takeDeleteOf(database, more)).toBe(true);
  expect(await requestOf(database, ask)).toMatchObject({ state: "seen", attention: "updated" });
  expect(await take(database, { ...theirs, mentionsBot: false })).toBe(false);
});

test("losing its mention cancels a request, and losing its question cancels it and our copy", async () => {
  const edited = await openIntake(theirs);
  expect(await take(edited, editMessage(theirs, "1700000300.000100", "never mind"))).toBe(true);
  expect(await requestOf(edited, theirs)).toMatchObject({ id: 2, closedReason: "mention_removed" });
  const deleted = await openIntake();
  await advance(deleted, "answering");
  expect(await takeDeleteOf(deleted, ask)).toBe(true);
  expect(await requestOf(deleted, ask)).toMatchObject({ closedReason: "source_deleted" });
  expect(await deleted.read((sql) => sql`SELECT text FROM messages`)).toEqual([{ text: null }]);
});

test("once the lead answers, edits change nothing and a new message asks again", async () => {
  const database = await openIntake();
  await advance(database, "answering");
  expect(await take(database, editMessage(ask, "1700000150.000100", "never mind"))).toBe(false);
  expect(await take(database, more)).toBe(true);
  expect(await take(database, editMessage(more, "1700000300.000100", "the seed step"))).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ state: "open", reason: "follow_up" });
});

test("a finished request's messages ask again only by gaining a mention, but a new reply follows up", async () => {
  const database = await openIntake(more);
  await advance(database, "answered");
  const kept = editMessage(ask, "1700000150.000100", "<@U-bot> can you look at staging?");
  expect(await take(database, kept)).toBe(false);
  expect(await take(database, editMessage(ask, "1700000160.000100", "never mind"))).toBe(false);
  expect(await takeDeleteOf(database, ask)).toBe(false);
  const mentioned = editMessage(more, "1700000300.000100", "<@U-bot> one more look?");
  expect(await take(database, mentioned)).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ id: 2, reason: "mention" });
  expect(await takeDeleteOf(database, more)).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ closedReason: "source_deleted" });
  expect(await take(database, replyMessage(ask, "1700000400.000100"))).toBe(true);
});

test("an okay follows up only when our newest message before it in the thread asked something", async () => {
  const database = await openIntake();
  await advance(database, "answered");
  const ours = (ts: SlackTs, text: string) =>
    replyMessage(ask, ts, { author: "self", userId: "U-bot", text });
  const okay = (ts: SlackTs) => replyMessage(ask, ts, { text: "ok" });
  expect(await take(database, ours("1700000200.000100", "Should I deploy to prod?"))).toBe(false);
  expect(await take(database, ours("1700000300.000100", "Deployed."))).toBe(false);
  const question = { userId: "U-allowed", text: "Is staging fine too?" };
  expect(await take(database, replyMessage(ask, "1700000320.000100", question))).toBe(false);
  expect(await take(database, okay("1700000350.000100"))).toBe(false);
  expect(await take(database, ours("1700000400.000100", "Anything else?"))).toBe(false);
  expect(await take(database, okay("1700000380.000100"))).toBe(false);
  expect(await take(database, okay("1700000450.000100"))).toBe(true);
  expect(await requestOf(database, okay("1700000450.000100"))).toMatchObject({
    id: 2,
    reason: "follow_up",
  });
});

import { expect, test } from "bun:test";
import { storeDelete, storeMessage } from "@activity/server/ledger";
import { ledgerLink } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { beginAnswer, confirmAnswer, serveRequest, type Request } from "@requests/model/lifecycle";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { readMessageRequest, readRequest, saveRequest } from "./database";
import { takeDelete, takeMessage, type IntakeLink } from "./intake";

const now = 1_700_001_000_000;

/** The link `createStoredLink` stores, as intake reads it. */
const link: IntakeLink = {
  id: "link",
  status: "active",
  requestMode: "mention",
  linkedAtTs: "1700000000.000100",
};

const ask = askMessage();
const more = replyMessage(ask, "1700000200.000100");

async function openIntake(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await take(database, ask);
  return database;
}

/** Stores `message` in the ledger and takes it, in one transaction as ingest does. */
function take(database: BridgeDatabase, message: SlackMessage, intakeLink = link) {
  return database.write(async (transaction) => {
    const stored = await storeMessage(transaction, ledgerLink(), message, false);
    return takeMessage(transaction, intakeLink, message, stored, now);
  });
}

function takeDeleteOf(database: BridgeDatabase, message: SlackMessage) {
  return database.write(async (transaction) => {
    await storeDelete(transaction, "link", message.channelId, message.ts);
    return takeDelete(transaction, message.channelId, message.ts, now);
  });
}

function requestOf(database: BridgeDatabase, message: SlackMessage) {
  return database.read((sql) => readMessageRequest(sql, message.channelId, message.ts));
}

/** Moves request `id` along, as the lead and the outbox do. */
function update(
  database: BridgeDatabase,
  id: number,
  change: <T extends Request>(request: T) => T,
) {
  return database.write(async (transaction) => {
    await saveRequest(transaction, change((await readRequest(transaction, id))!));
  });
}

const read = <T extends Request>(request: T) => serveRequest(request, now);
const answering = <T extends Request>(request: T) => beginAnswer(read(request), now);
const answered = <T extends Request>(request: T) => confirmAnswer(answering(request));

test("a mention opens a request that holds its message, and a redelivery asks nothing new", async () => {
  const database = await openIntake();
  expect(await requestOf(database, ask)).toMatchObject({
    id: 1,
    state: "open",
    reason: "mention",
    sourceTs: ask.ts,
    requesterUserId: "U-owner",
    createdAt: now,
  });
  expect(await take(database, ask)).toBe(false);
  expect(await take(database, editMessage(ask, "1700000150.000100", ask.text))).toBe(false);
});

test("the requester's later messages join their request and flag it once the lead read it", async () => {
  const database = await openIntake();
  expect(await take(database, more)).toBe(true);
  await update(database, 1, read);
  const edited = editMessage(more, "1700000300.000100", "it fails on the seed step");
  expect(await take(database, edited)).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ id: 1, attention: "updated" });
  await update(database, 1, read);
  expect(await takeDeleteOf(database, more)).toBe(true);
  expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({
    state: "seen",
    attention: "updated",
  });
});

test("editing the mention out of a request, or deleting it, cancels the request", async () => {
  const removed = await openIntake();
  await update(removed, 1, read);
  expect(await take(removed, editMessage(ask, "1700000300.000100", "never mind"))).toBe(true);
  expect(await requestOf(removed, ask)).toMatchObject({
    state: "cancelled",
    closedReason: "mention_removed",
  });
  const deleted = await openIntake();
  expect(await takeDeleteOf(deleted, ask)).toBe(true);
  expect(await requestOf(deleted, ask)).toMatchObject({
    state: "cancelled",
    closedReason: "source_deleted",
  });
});

test("once the lead answers, edits change nothing and a new message asks again", async () => {
  const database = await openIntake();
  await update(database, 1, answering);
  expect(await take(database, editMessage(ask, "1700000150.000100", "never mind"))).toBe(false);
  expect(await take(database, more)).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ id: 2, reason: "follow_up" });
  expect(await requestOf(database, ask)).toMatchObject({ id: 1, state: "answering" });
});

test("after an answer, a thank-you in the thread asks nothing but a new question does", async () => {
  const database = await openIntake();
  await update(database, 1, answered);
  expect(await take(database, replyMessage(ask, "1700000200.000100", { text: "thanks!" }))).toBe(
    false,
  );
  const again = replyMessage(ask, "1700000300.000100", { text: "and on staging?" });
  expect(await take(database, again)).toBe(true);
  expect(await requestOf(database, again)).toMatchObject({ id: 2, reason: "follow_up" });
});

test("a finished request's message asks again only by gaining a mention", async () => {
  const database = await openIntake();
  await take(database, more);
  await update(database, 1, answered);
  const kept = editMessage(
    ask,
    "1700000150.000100",
    "<@U-bot> can you look at the deploy, please?",
  );
  expect(await take(database, kept)).toBe(false);
  expect(await take(database, editMessage(ask, "1700000160.000100", "never mind"))).toBe(false);
  expect(await takeDeleteOf(database, more)).toBe(false);
  expect(await requestOf(database, ask)).toMatchObject({ id: 1, state: "answered" });
  const mentioned = editMessage(ask, "1700000170.000100", "<@U-bot> one more look?");
  expect(await take(database, mentioned)).toBe(true);
  expect(await requestOf(database, ask)).toMatchObject({ id: 2, state: "open", reason: "mention" });
});

test("a paused link's requests still take their requesters' messages, but nothing new asks", async () => {
  const database = await openIntake();
  const paused = { ...link, status: "paused" as const };
  expect(await take(database, more, paused)).toBe(true);
  expect(await requestOf(database, more)).toMatchObject({ id: 1 });
  const other = askMessage("1700000400.000100");
  expect(await take(database, other, paused)).toBe(false);
  expect(await requestOf(database, other)).toBeNull();
});

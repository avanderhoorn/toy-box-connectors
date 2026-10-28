import { expect, test } from "bun:test";
import {
  storeDelete,
  storeMessage,
  storeWithdrawal,
  type LedgerLink,
} from "@activity/server/ledger";
import { ledgerLink } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import {
  beginAnswer,
  confirmAnswer,
  serveRequest,
  startProgress,
  type RequestState,
} from "@requests/model/lifecycle";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { readInputHash, readRequest, saveRequest, type StoredRequest } from "./database";
import { takeDelete, takeMessage, takeWithdrawal, type IntakeLink } from "./intake";

const now = 1_700_001_000_000;
const unchanged = { changed: false, opened: false };

/** The link `createStoredLink` stores, as intake reads it. */
const link: IntakeLink = {
  id: "link",
  status: "active",
  requestMode: "mention",
  linkedAtTs: "1700000000.000100",
};

const ask = askMessage();
const more = replyMessage(ask, "1700000200.000100");

/** How a request reaches each state before answered. */
const beforeAnswered: [RequestState, (request: StoredRequest) => StoredRequest][] = [
  ["open", (request) => request],
  ["seen", (request) => serveRequest(request, now)],
  ["in_progress", (request) => startProgress(serveRequest(request, now), now)],
  ["answering", (request) => beginAnswer(serveRequest(request, now), now)],
];

function answer(request: StoredRequest) {
  return confirmAnswer(beginAnswer(serveRequest(request, now), now), request.inputRev, now);
}

async function openIntake(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
}

/** Stores `message` in the ledger and takes it, in one transaction as ingest does. */
function take(
  database: BridgeDatabase,
  message: SlackMessage,
  options: { link?: IntakeLink; into?: LedgerLink; now?: number } = {},
) {
  return database.write(async (transaction) => {
    const stored = await storeMessage(transaction, options.into ?? ledgerLink(), message);
    return takeMessage(transaction, options.link ?? link, message, stored, {
      late: false,
      now: options.now ?? now,
    });
  });
}

function takeDeleteOf(database: BridgeDatabase, message: SlackMessage) {
  return database.write(async (transaction) => {
    await storeDelete(transaction, "link", message.channelId, message.ts);
    return takeDelete(transaction, message.channelId, message.ts, now);
  });
}

function takeWithdrawalOf(database: BridgeDatabase, message: SlackMessage, at = now) {
  return database.write(async (transaction) => {
    await storeWithdrawal(transaction, "link", message.channelId, message.ts);
    return takeWithdrawal(transaction, message.channelId, message.ts, at);
  });
}

/** Applies a lifecycle change to request `id`, as the lead's commands do. */
function change(
  database: BridgeDatabase,
  id: number,
  apply: (request: StoredRequest) => StoredRequest,
) {
  return database.write(async (transaction) =>
    saveRequest(transaction, apply((await readRequest(transaction, id))!)),
  );
}

/** Queues a final reply to request 1's first revision, and sends a follow-up to it. */
async function queueReplies(database: BridgeDatabase) {
  await createStoredOutboxItem(database, 1);
  await createStoredOutboxItem(database, 2, { phase: "follow_up", state: "sending" });
}

function readRequests(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`
      SELECT id, source_ts, reason, state, input_rev, attention FROM requests ORDER BY id
    `,
  );
}

function readClosings(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, state, closed_reason FROM requests ORDER BY id`);
}

function readUnverified(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`
      SELECT id, state, input_rev, attention, source_unverified_at FROM requests ORDER BY id
    `,
  );
}

function readMembers(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT request_id, ts FROM request_messages ORDER BY ts`);
}

function readItems(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT number, state FROM outbox ORDER BY number`);
}

test("a mention opens a request that holds its message", async () => {
  const database = await openIntake();

  expect(await take(database, ask)).toEqual({ changed: true, opened: true });
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, reason: "mention", state: "open", input_rev: 1, attention: null },
  ]);
  expect(await readMembers(database)).toEqual([{ request_id: 1, ts: ask.ts }]);
  // Opening hashes the input as revising does, so the request stays at its first revision.
  expect((await database.read((sql) => readRequest(sql, 1)))?.inputHash).toBe(
    await database.read((sql) => readInputHash(sql, 1)),
  );
});

test("a message stored again, or a version that says the same thing, asks nothing new", async () => {
  const database = await openIntake();
  await take(database, ask);

  expect(await take(database, ask)).toEqual(unchanged);
  const restated = { ...ask, editedTs: "1700000150.000100", version: "1700000150.000100" };
  expect(await take(database, restated)).toEqual(unchanged);
  // Seeing a message again isn't an edit, so one too old to ask the first time still doesn't.
  const old = askMessage("1700000300.000100");
  const later = now + 8 * 24 * 60 * 60_000;
  expect(await take(database, old, { now: later })).toEqual(unchanged);
  expect(await take(database, old, { now: later })).toEqual(unchanged);
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, reason: "mention", state: "open", input_rev: 1, attention: null },
  ]);
});

test("a message filled in once its author is allowed asks nothing", async () => {
  const database = await openIntake();
  const early = askMessage("1700000300.000100", { userId: "U-later" });
  expect(await take(database, early)).toEqual(unchanged);

  const allowed = ledgerLink({ allowlist: new Set(["U-allowed", "U-later"]) });
  expect(await take(database, early, { into: allowed })).toEqual(unchanged);
  expect(await readRequests(database)).toEqual([]);
});

test("a requester's later message in the thread joins their request and revises it", async () => {
  const database = await openIntake();
  await take(database, ask);

  expect(await take(database, more)).toEqual({ changed: true, opened: false });
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, reason: "mention", state: "open", input_rev: 2, attention: null },
  ]);

  await change(database, 1, (request) => serveRequest(request, now));
  const last = replyMessage(ask, "1700000300.000100", { text: "and the rollback too" });
  expect(await take(database, last)).toEqual({ changed: true, opened: false });
  expect(await readRequests(database)).toEqual([
    {
      id: 1,
      source_ts: ask.ts,
      reason: "mention",
      state: "seen",
      input_rev: 3,
      attention: "updated",
    },
  ]);
  expect(await readMembers(database)).toEqual([
    { request_id: 1, ts: ask.ts },
    { request_id: 1, ts: more.ts },
    { request_id: 1, ts: last.ts },
  ]);
});

test("a requester who asked before in a thread opens a follow-up there", async () => {
  const database = await openIntake();
  await take(database, ask);
  await change(database, 1, answer);

  expect(await take(database, more)).toEqual({ changed: true, opened: true });
  expect(await readMembers(database)).toEqual([
    { request_id: 1, ts: ask.ts },
    { request_id: 2, ts: more.ts },
  ]);

  // A follow-up never had a mention to lose, so editing its source only revises it.
  const seed = editMessage(more, "1700000250.000100", "it fails on the seed step");
  expect(await take(database, seed)).toEqual({ changed: true, opened: false });
  expect(await readRequests(database)).toEqual([
    {
      id: 1,
      source_ts: ask.ts,
      reason: "mention",
      state: "answered",
      input_rev: 1,
      attention: null,
    },
    {
      id: 2,
      source_ts: more.ts,
      reason: "follow_up",
      state: "open",
      input_rev: 2,
      attention: null,
    },
  ]);
});

test("a substantive edit revises the request its message belongs to", async () => {
  const database = await openIntake();
  await take(database, ask);
  await change(database, 1, (request) => serveRequest(request, now));

  const edit = editMessage(
    ask,
    "1700000150.000100",
    "<@U-bot> can you look at the staging deploy?",
  );
  expect(await take(database, edit)).toEqual({ changed: true, opened: false });
  expect(await readRequests(database)).toEqual([
    {
      id: 1,
      source_ts: ask.ts,
      reason: "mention",
      state: "seen",
      input_rev: 2,
      attention: "updated",
    },
  ]);
});

test("editing the mention out cancels a request in any state before answered", async () => {
  for (const [state, reach] of beforeAnswered) {
    const database = await openIntake();
    await take(database, ask);
    await change(database, 1, reach);
    await queueReplies(database);
    expect(await readClosings(database)).toEqual([{ id: 1, state, closed_reason: null }]);

    const edit = editMessage(ask, "1700000150.000100", "can you look at the deploy?");
    expect(await take(database, edit)).toEqual({ changed: true, opened: false });
    expect(await readClosings(database)).toEqual([
      { id: 1, state: "cancelled", closed_reason: "mention_removed" },
    ]);
    // A reply already sending may still land.
    expect(await readItems(database)).toEqual([
      { number: 1, state: "cancelled" },
      { number: 2, state: "sending" },
    ]);
  }
});

test("editing the mention out of a message that joined a request only revises it", async () => {
  const database = await openIntake();
  await take(database, ask);
  const nudge = replyMessage(ask, "1700000200.000100", {
    text: "<@U-bot> any news?",
    mentions: ["U-bot"],
    mentionsBot: true,
  });
  await take(database, nudge);

  const edit = editMessage(nudge, "1700000250.000100", "any news?");
  expect(await take(database, edit)).toEqual({ changed: true, opened: false });
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, reason: "mention", state: "open", input_rev: 3, attention: null },
  ]);
});

test("editing a finished request's messages without adding a mention changes nothing", async () => {
  const database = await openIntake();
  await take(database, ask);
  await take(database, more);
  await change(database, 1, answer);

  const staging = "<@U-bot> can you look at the staging deploy?";
  expect(await take(database, editMessage(ask, "1700000150.000100", staging))).toEqual(unchanged);
  const seed = "it fails on the seed step";
  expect(await take(database, editMessage(more, "1700000250.000100", seed))).toEqual(unchanged);
  expect(await readRequests(database)).toEqual([
    {
      id: 1,
      source_ts: ask.ts,
      reason: "mention",
      state: "answered",
      input_rev: 2,
      attention: null,
    },
  ]);
});

test("a mention added back to a finished request's message opens a new request for it", async () => {
  const database = await openIntake();
  await take(database, ask);
  await change(database, 1, answer);

  const dropped = editMessage(ask, "1700000150.000100", "can you look at the deploy?");
  expect(await take(database, dropped)).toEqual(unchanged);
  const again = editMessage(ask, "1700000160.000100", "<@U-bot> can you look at the deploy again?");
  expect(await take(database, again)).toEqual({ changed: true, opened: true });
  expect(await readRequests(database)).toEqual([
    {
      id: 1,
      source_ts: ask.ts,
      reason: "mention",
      state: "answered",
      input_rev: 1,
      attention: null,
    },
    { id: 2, source_ts: ask.ts, reason: "mention", state: "open", input_rev: 1, attention: null },
  ]);
  expect(await readMembers(database)).toEqual([{ request_id: 2, ts: ask.ts }]);
});

test("an edit that adds a mention asks however old its message is, though a first sight doesn't", async () => {
  const database = await openIntake();
  const later = now + 8 * 24 * 60 * 60_000;
  const plain = askMessage(ask.ts, {
    text: "the deploy is broken",
    mentions: [],
    mentionsBot: false,
  });
  expect(await take(database, plain)).toEqual(unchanged);
  expect(await take(database, askMessage("1700000300.000100"), { now: later })).toEqual(unchanged);

  const mention = editMessage(plain, "1700000400.000100", "<@U-bot> the deploy is broken");
  expect(await take(database, mention, { now: later })).toEqual({ changed: true, opened: true });
  expect(await readMembers(database)).toEqual([{ request_id: 1, ts: ask.ts }]);
});

test("a paused link's requests still follow their messages, but nothing new asks", async () => {
  const database = await openIntake();
  const paused: IntakeLink = { ...link, status: "paused" };
  await take(database, ask);

  const staging = editMessage(ask, "1700000150.000100", "<@U-bot> and staging?");
  expect(await take(database, staging, { link: paused })).toEqual({ changed: true, opened: false });
  const another = askMessage("1700000300.000100", { userId: "U-allowed" });
  expect(await take(database, another, { link: paused })).toEqual(unchanged);
  const dropped = editMessage(ask, "1700000160.000100", "and staging?");
  expect(await take(database, dropped, { link: paused })).toEqual({ changed: true, opened: false });
  expect(await readClosings(database)).toEqual([
    { id: 1, state: "cancelled", closed_reason: "mention_removed" },
  ]);
});

test("deleting a request's source cancels it in any state before answered", async () => {
  for (const [state, reach] of beforeAnswered) {
    const database = await openIntake();
    await take(database, ask);
    await take(database, more);
    await change(database, 1, reach);
    await queueReplies(database);
    expect(await readClosings(database)).toEqual([{ id: 1, state, closed_reason: null }]);

    expect(await takeDeleteOf(database, ask)).toBe(true);
    expect(await readClosings(database)).toEqual([
      { id: 1, state: "cancelled", closed_reason: "source_deleted" },
    ]);
    // A reply already sending may still land.
    expect(await readItems(database)).toEqual([
      { number: 1, state: "cancelled" },
      { number: 2, state: "sending" },
    ]);
  }
});

test("deleting another of a request's messages revises it", async () => {
  const database = await openIntake();
  await take(database, ask);
  const opened = (await database.read((sql) => readRequest(sql, 1)))?.inputHash;
  await take(database, more);

  expect(await takeDeleteOf(database, more)).toBe(true);
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, reason: "mention", state: "open", input_rev: 3, attention: null },
  ]);
  expect((await database.read((sql) => readRequest(sql, 1)))?.inputHash).toBe(opened);
});

test("deleting a finished request's message, or one that asked nothing, changes nothing", async () => {
  const database = await openIntake();
  await take(database, ask);
  await change(database, 1, answer);
  const aside = askMessage("1700000300.000100", {
    text: "green again",
    mentions: [],
    mentionsBot: false,
  });
  await take(database, aside);

  expect(await takeDeleteOf(database, ask)).toBe(false);
  expect(await takeDeleteOf(database, aside)).toBe(false);
  expect(await takeDeleteOf(database, askMessage("1700000400.000100"))).toBe(false);
  expect(await readClosings(database)).toEqual([{ id: 1, state: "answered", closed_reason: null }]);
});

test("Slack withdrawing a request's source holds its replies and revises it, in any state before answered", async () => {
  for (const [state, reach] of beforeAnswered) {
    const database = await openIntake();
    await take(database, ask);
    await take(database, more);
    await change(database, 1, reach);
    await queueReplies(database);

    expect(await takeWithdrawalOf(database, ask)).toBe(true);
    // A final reply to an older revision can't answer, so an answering request goes back to the lead.
    const answering = state === "answering";
    expect(await readUnverified(database)).toEqual([
      {
        id: 1,
        state: answering ? "in_progress" : state,
        input_rev: 3,
        attention: state === "open" ? null : "updated",
        source_unverified_at: now,
      },
    ]);
    // Unlike a delete, nobody took the question back, so its other replies wait rather than end.
    expect(await readItems(database)).toEqual([
      { number: 1, state: answering ? "superseded" : "queued" },
      { number: 2, state: "sending" },
    ]);
  }
});

test.each([
  [
    "an edit of its source",
    (database: BridgeDatabase) =>
      take(database, editMessage(ask, "1700000150.000100", "<@U-bot> can you look at staging?")),
  ],
  [
    "a message that joins it",
    (database: BridgeDatabase) =>
      take(database, replyMessage(ask, "1700000300.000100", { text: "and the rollback too" })),
  ],
  ["deleting another of its messages", (database: BridgeDatabase) => takeDeleteOf(database, more)],
  [
    "Slack withdrawing another of its messages",
    (database: BridgeDatabase) => takeWithdrawalOf(database, more),
  ],
  ["Slack withdrawing its source", (database: BridgeDatabase) => takeWithdrawalOf(database, ask)],
] as const)(
  "%s supersedes an answering request's final reply and gives the request back to the lead",
  async (_, revise) => {
    const database = await openIntake();
    await take(database, ask);
    await take(database, more);
    await change(database, 1, (request) => beginAnswer(serveRequest(request, now), now));
    await createStoredOutboxItem(database, 1, { request_rev: 2 });

    await revise(database);
    expect(await readRequests(database)).toEqual([
      {
        id: 1,
        source_ts: ask.ts,
        reason: "mention",
        state: "in_progress",
        input_rev: 3,
        attention: "updated",
      },
    ]);
    expect(await readItems(database)).toEqual([{ number: 1, state: "superseded" }]);
  },
);

test("a source withdrawn again stays held without being revised again", async () => {
  const database = await openIntake();
  await take(database, ask);
  await takeWithdrawalOf(database, ask);
  expect(await takeWithdrawalOf(database, ask, now + 1)).toBe(false);
  await change(database, 1, (request) => ({ ...request, sourceUnverifiedAt: null }));

  expect(await takeWithdrawalOf(database, ask, now + 2)).toBe(true);
  expect(await readUnverified(database)).toEqual([
    { id: 1, state: "open", input_rev: 2, attention: null, source_unverified_at: now + 2 },
  ]);
});

test("a source held since an outage keeps that time once Slack withdraws it", async () => {
  const database = await openIntake();
  await take(database, ask);
  await change(database, 1, (request) => ({ ...request, sourceUnverifiedAt: now - 1 }));

  expect(await takeWithdrawalOf(database, ask)).toBe(true);
  expect(await readUnverified(database)).toEqual([
    { id: 1, state: "open", input_rev: 2, attention: null, source_unverified_at: now - 1 },
  ]);
});

test("withdrawing another of a request's messages revises it and holds nothing", async () => {
  const database = await openIntake();
  await take(database, ask);
  const opened = (await database.read((sql) => readRequest(sql, 1)))?.inputHash;
  await take(database, more);

  expect(await takeWithdrawalOf(database, more)).toBe(true);
  expect(await readUnverified(database)).toEqual([
    { id: 1, state: "open", input_rev: 3, attention: null, source_unverified_at: null },
  ]);
  expect((await database.read((sql) => readRequest(sql, 1)))?.inputHash).toBe(opened);
});

test("withdrawing a finished request's message, or one that asked nothing, changes nothing", async () => {
  const database = await openIntake();
  await take(database, ask);
  await change(database, 1, answer);
  const aside = askMessage("1700000300.000100", {
    text: "green again",
    mentions: [],
    mentionsBot: false,
  });
  await take(database, aside);

  expect(await takeWithdrawalOf(database, ask)).toBe(false);
  expect(await takeWithdrawalOf(database, aside)).toBe(false);
  expect(await takeWithdrawalOf(database, askMessage("1700000400.000100"))).toBe(false);
  expect(await readUnverified(database)).toEqual([
    { id: 1, state: "answered", input_rev: 1, attention: null, source_unverified_at: null },
  ]);
});

test("its requester deleting a withdrawn source still cancels the request", async () => {
  const database = await openIntake();
  await take(database, ask);
  await takeWithdrawalOf(database, ask);

  expect(await takeDeleteOf(database, ask)).toBe(true);
  expect(await readClosings(database)).toEqual([
    { id: 1, state: "cancelled", closed_reason: "source_deleted" },
  ]);
  expect(await readUnverified(database)).toEqual([
    { id: 1, state: "cancelled", input_rev: 2, attention: null, source_unverified_at: null },
  ]);
});

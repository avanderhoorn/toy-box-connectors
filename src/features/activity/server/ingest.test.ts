import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessage, SlackMessageEvent } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { ingestMessageEvent, type IngestContext, type Ingested } from "./ingest";

const context: IngestContext = {
  botUserId: "U-bot",
  ownerUserId: "U-owner",
  late: false,
  now: 1_700_001_000_000,
};

const ask = askMessage();

/** A linked channel that allows U-allowed, as `createStoredLink` stores it. */
async function openIngest(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await database.write(
    (transaction) => transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-allowed', 0)
    `,
  );
  return database;
}

function ingest(
  database: BridgeDatabase,
  event: SlackMessageEvent,
  changes: Partial<IngestContext> = {},
) {
  return database.write((transaction) =>
    ingestMessageEvent(transaction, event, { ...context, ...changes }),
  );
}

function posted(message: SlackMessage, edit = false): SlackMessageEvent {
  return { kind: "message", message, edit };
}

function stored(requestsChanged: boolean, purged: string[] = []): Ingested {
  return { kind: "stored", linkId: "link", requestsChanged, purged };
}

function readMessages(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT ts, author_role, text FROM messages ORDER BY ts`);
}

function readRequests(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT id, source_ts, requester_user_id, late FROM requests ORDER BY id`,
  );
}

function readAuthors(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT ts, user_id, team_id, author_role FROM messages ORDER BY ts`,
  );
}

function readThreads(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT thread_ts, tracked_reason, latest_reply_ts FROM threads ORDER BY thread_ts`,
  );
}

test("a claim is consumed before anything is stored, wherever it's posted", async () => {
  const database = await openIngest();
  // Claims only read Slack's own user ID shape.
  const bot = { botUserId: "U0BOT" };
  const claim = askMessage(ask.ts, { text: "<@U0BOT> claim 4F7Q-2KD9" });

  expect(await ingest(database, posted(claim), bot)).toEqual({
    kind: "claim",
    claim: { code: "4F7Q-2KD9" },
  });
  expect(await ingest(database, posted({ ...claim, channelId: "C-elsewhere" }), bot)).toEqual({
    kind: "claim",
    claim: { code: "4F7Q-2KD9" },
  });
  const edit = editMessage(ask, "1700000150.000100", "<@U0BOT> claim it, please");
  expect(await ingest(database, posted(edit, true), bot)).toEqual({
    kind: "claim",
    claim: { code: null },
  });
  expect(await readMessages(database)).toEqual([]);
  expect(await readRequests(database)).toEqual([]);
});

test("nothing from a channel no link watches is stored", async () => {
  const database = await openIngest();
  const elsewhere = askMessage(ask.ts, { channelId: "C-elsewhere" });

  expect(await ingest(database, posted(elsewhere))).toEqual({ kind: "unlinked" });
  const deleted = { kind: "deleted", channelId: "C-elsewhere", ts: ask.ts } as const;
  expect(await ingest(database, deleted)).toEqual({ kind: "unlinked" });
  const replied = {
    kind: "replied",
    channelId: "C-elsewhere",
    threadTs: ask.ts,
    latestReplyTs: "1700000200.000100",
  } as const;
  expect(await ingest(database, replied)).toEqual({ kind: "unlinked" });
  expect(await readMessages(database)).toEqual([]);
  expect(await database.read((sql) => sql`SELECT * FROM changes`)).toEqual([]);
});

test("a mention opens a request and tracks its thread", async () => {
  const database = await openIngest();

  expect(await ingest(database, posted(ask))).toEqual(stored(true));
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, requester_user_id: "U-owner", late: 0 },
  ]);
  expect(await readThreads(database)).toEqual([
    { thread_ts: ask.ts, tracked_reason: "request", latest_reply_ts: null },
  ]);
  expect(await database.read((sql) => sql`SELECT * FROM coverage`)).toEqual([]);
});

test("a request gap repair finds is late", async () => {
  const database = await openIngest();

  expect(await ingest(database, posted(ask), { late: true })).toEqual(stored(true));
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, requester_user_id: "U-owner", late: 1 },
  ]);
});

test("a request asked in a reply has its thread hydrated", async () => {
  const database = await openIngest();
  const root = askMessage(ask.ts, {
    userId: "U-observed",
    text: "the deploy is red",
    mentions: [],
    mentionsBot: false,
  });
  const question = replyMessage(root, "1700000200.000100", {
    userId: "U-allowed",
    text: "<@U-bot> what broke?",
    mentions: ["U-bot"],
    mentionsBot: true,
  });

  expect(await ingest(database, posted(root))).toEqual(stored(false));
  expect(await ingest(database, posted(question))).toEqual(stored(true));
  expect(await readThreads(database)).toEqual([
    { thread_ts: root.ts, tracked_reason: "request", latest_reply_ts: question.ts },
  ]);
  expect(
    await database.read(
      (sql) => sql`SELECT link_id, scope, thread_ts, reason, state FROM coverage`,
    ),
  ).toEqual([
    { link_id: "link", scope: "thread", thread_ts: root.ts, reason: "thread", state: "open" },
  ]);
});

test("someone off the allowlist asks nothing, and is kept as observed only in request threads", async () => {
  const database = await openIngest();
  await ingest(database, posted(ask));
  const outsider = { userId: "U-observed", text: "<@U-bot> restart prod too" };
  const inThread = replyMessage(ask, "1700000200.000100", {
    ...outsider,
    mentions: ["U-bot"],
    mentionsBot: true,
  });
  const atRoot = askMessage("1700000300.000100", outsider);

  expect(await ingest(database, posted(inThread))).toEqual(stored(false));
  expect(await ingest(database, posted(atRoot))).toEqual(stored(false));
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: ask.ts, requester_user_id: "U-owner", late: 0 },
  ]);
  expect(await readMessages(database)).toEqual([
    { ts: ask.ts, author_role: "owner", text: ask.text },
    { ts: inThread.ts, author_role: "observed", text: outsider.text },
    { ts: atRoot.ts, author_role: "observed", text: null },
  ]);
});

test("the stored link and the installation decide whose text is kept", async () => {
  const database = await openIngest();
  const said = { text: "the deploy is red", mentions: [], mentionsBot: false };
  await ingest(database, posted(askMessage("1700000100.000100", said)));
  await ingest(database, posted(askMessage("1700000200.000100", { ...said, userId: "U-allowed" })));
  await ingest(
    database,
    posted(askMessage("1700000300.000100", { ...said, userId: "U-observed" })),
  );
  await database.write((transaction) => transaction`UPDATE links SET observe = 'channel'`);
  await ingest(
    database,
    posted(askMessage("1700000500.000100", { ...said, userId: "U-observed" })),
  );

  expect(await readMessages(database)).toEqual([
    { ts: "1700000100.000100", author_role: "owner", text: said.text },
    { ts: "1700000200.000100", author_role: "allowed", text: said.text },
    { ts: "1700000300.000100", author_role: "observed", text: null },
    { ts: "1700000500.000100", author_role: "observed", text: said.text },
  ]);
});

test("a person asks by their ID, whatever workspace the message names", async () => {
  const database = await openIngest();
  const sibling = askMessage(ask.ts, { teamId: "T-sibling" });
  const unnamed = askMessage("1700000200.000100", { userId: "U-allowed", teamId: null });

  expect(await ingest(database, posted(sibling))).toEqual(stored(true));
  expect(await ingest(database, posted(unnamed))).toEqual(stored(true));
  expect(await readAuthors(database)).toEqual([
    { ts: sibling.ts, user_id: "U-owner", team_id: "T-sibling", author_role: "owner" },
    { ts: unnamed.ts, user_id: "U-allowed", team_id: null, author_role: "allowed" },
  ]);
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: sibling.ts, requester_user_id: "U-owner", late: 0 },
    { id: 2, source_ts: unnamed.ts, requester_user_id: "U-allowed", late: 0 },
  ]);
});

test("an alias is stored, asks and joins as the person it names", async () => {
  const database = await openIngest();
  await database.write(
    (transaction) => transaction`
      INSERT INTO user_aliases (alias_id, user_id)
      VALUES ('W-owner', 'U-owner'), ('W-allowed', 'U-allowed')
    `,
  );
  const asked = askMessage(ask.ts, { userId: "W-owner" });
  const more = replyMessage(asked, "1700000200.000100", { userId: "U-owner" });
  const allowed = askMessage("1700000300.000100", { userId: "W-allowed" });
  const stranger = askMessage("1700000400.000100", { userId: "W-stranger" });

  for (const message of [asked, more, allowed]) {
    expect(await ingest(database, posted(message))).toEqual(stored(true));
  }
  expect(await ingest(database, posted(stranger))).toEqual(stored(false));
  expect(await readAuthors(database)).toEqual([
    { ts: asked.ts, user_id: "U-owner", team_id: "T-home", author_role: "owner" },
    { ts: more.ts, user_id: "U-owner", team_id: "T-home", author_role: "owner" },
    { ts: allowed.ts, user_id: "U-allowed", team_id: "T-home", author_role: "allowed" },
    { ts: stranger.ts, user_id: "W-stranger", team_id: "T-home", author_role: "observed" },
  ]);
  expect(await readRequests(database)).toEqual([
    { id: 1, source_ts: asked.ts, requester_user_id: "U-owner", late: 0 },
    { id: 2, source_ts: allowed.ts, requester_user_id: "U-allowed", late: 0 },
  ]);
  expect(
    await database.read((sql) => sql`SELECT request_id, ts FROM request_messages ORDER BY ts`),
  ).toEqual([
    { request_id: 1, ts: asked.ts },
    { request_id: 1, ts: more.ts },
    { request_id: 2, ts: allowed.ts },
  ]);
});

test("an edit and a delete reach the request their message opened", async () => {
  const database = await openIngest();
  await ingest(database, posted(ask));

  const edit = editMessage(ask, "1700000150.000100", "<@U-bot> and staging?");
  expect(await ingest(database, posted(edit, true))).toEqual(stored(true));
  expect(await ingest(database, { kind: "deleted", channelId: "C-link", ts: ask.ts })).toEqual(
    stored(true),
  );
  expect(
    await database.read((sql) => sql`SELECT id, state, input_rev, closed_reason FROM requests`),
  ).toEqual([{ id: 1, state: "cancelled", input_rev: 2, closed_reason: "source_deleted" }]);
});

test("an edit that drops a file, and a delete, hand back local copies to remove", async () => {
  const database = await openIngest();
  const shared = askMessage(ask.ts, { files: [file("F1"), file("F2")] });
  await ingest(database, posted(shared));
  await database.write(
    (transaction) => transaction`
      UPDATE files SET state = 'fetched', local_path = file_id || '.png', fetched_at = 1
    `,
  );

  const edit = { ...editMessage(shared, "1700000150.000100", shared.text), files: [file("F1")] };
  expect(await ingest(database, posted(edit, true))).toEqual(stored(true, ["F2.png"]));
  expect(await ingest(database, { kind: "deleted", channelId: "C-link", ts: ask.ts })).toEqual(
    stored(true, ["F1.png"]),
  );
});

test("a reply raises its tracked thread's newest reply and changes no request", async () => {
  const database = await openIngest();
  await ingest(database, posted(ask));
  const replied = (latestReplyTs: string | null) =>
    ingest(database, { kind: "replied", channelId: "C-link", threadTs: ask.ts, latestReplyTs });

  expect(await replied("1700000400.000100")).toEqual(stored(false));
  expect(await replied(null)).toEqual(stored(false));
  expect(await readThreads(database)).toEqual([
    { thread_ts: ask.ts, tracked_reason: "request", latest_reply_ts: "1700000400.000100" },
  ]);
});

function file(id: string) {
  return { id, name: `${id}.png`, mimetype: "image/png", size: 2048 };
}

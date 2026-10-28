import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessage } from "@slackapi/model/messages";
import {
  noteReply,
  storeDelete,
  storeMessage,
  trackRequestThread,
  type LedgerLink,
} from "./ledger";

const link: LedgerLink = {
  id: "link",
  audience: {
    teamId: "T-home",
    ownerUserId: "U-owner",
    allowlist: new Set(["U-allowed"]),
    observe: "requesters",
  },
};

/** The owner asks the bot something at the root of the linked channel. */
const ask: SlackMessage = {
  channelId: "C-link",
  ts: "1700000100.000100",
  threadTs: null,
  rootTs: "1700000100.000100",
  isReply: false,
  userId: "U-owner",
  teamId: "T-home",
  subtype: null,
  author: "person",
  text: "<@U-bot> can you look at the deploy?",
  files: [],
  mentions: ["U-bot"],
  mentionsBot: true,
  editedTs: null,
  version: "1700000100.000100",
  latestReplyTs: null,
};

/** The owner's edit of `ask`. */
const edit: SlackMessage = {
  ...ask,
  text: "<@U-bot> can you look at the staging deploy?",
  editedTs: "1700000200.000100",
  version: "1700000200.000100",
};

/** Someone not on the allowlist replies in `ask`'s thread. */
const aside: SlackMessage = {
  ...ask,
  ts: "1700000300.000100",
  threadTs: ask.ts,
  isReply: true,
  userId: "U-observed",
  text: "same here",
  mentions: [],
  mentionsBot: false,
  version: "1700000300.000100",
};

/** `message` posted on its own at the channel's root at `ts`. */
function rootAt(message: SlackMessage, ts: string): SlackMessage {
  return {
    ...message,
    ts,
    threadTs: null,
    rootTs: ts,
    isReply: false,
    editedTs: null,
    version: ts,
  };
}

async function openLedger(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
}

function store(database: BridgeDatabase, message: SlackMessage, into = link) {
  return database.write((transaction) => storeMessage(transaction, into, message));
}

function storeDeleteOf(database: BridgeDatabase, message: SlackMessage) {
  return database.write((transaction) =>
    storeDelete(transaction, link.id, message.channelId, message.ts),
  );
}

/** A request opens on `source` at `now`. */
function track(database: BridgeDatabase, source: SlackMessage, now = 1_700_001_000_000) {
  return database.write((transaction) => trackRequestThread(transaction, link.id, source, now));
}

// Bun's toMatchObject compares the rows of a query result whole, so the reads copy them out.
function readMessages(database: BridgeDatabase) {
  return database.read(async (sql) => [
    ...(await sql`
      SELECT ts, eligible, author_role, text, files, content_hash IS NOT NULL AS hashed,
        mentions_bot, deleted, version, updated_seq
      FROM messages ORDER BY ts
    `),
  ]);
}

function readChanges(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT seq, ts, kind FROM changes ORDER BY seq`);
}

function readFiles(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT file_id, ts, state, local_path FROM files ORDER BY file_id`,
  );
}

test("a message stored again is still one row with one change", async () => {
  const database = await openLedger();

  expect((await store(database, ask)).decision).toEqual({ kind: "insert", change: "new" });
  expect((await store(database, ask)).decision).toEqual({ kind: "ignore", reason: "duplicate" });
  expect(await readMessages(database)).toEqual([
    {
      ts: ask.ts,
      eligible: 1,
      author_role: "owner",
      text: ask.text,
      files: "[]",
      hashed: 1,
      mentions_bot: 1,
      deleted: 0,
      version: ask.version,
      updated_seq: 1,
    },
  ]);
  expect(await readChanges(database)).toEqual([{ seq: 1, ts: ask.ts, kind: "new" }]);
});

test("an edit replaces the text and appends an edited change", async () => {
  const database = await openLedger();
  await store(database, ask);

  const stored = await store(database, edit);
  expect(stored).toMatchObject({
    decision: { kind: "update", change: "edited" },
    mentionedBot: true,
  });
  expect(await readMessages(database)).toMatchObject([
    { text: edit.text, version: edit.version, updated_seq: 2 },
  ]);
  expect(await readChanges(database)).toEqual([
    { seq: 1, ts: ask.ts, kind: "new" },
    { seq: 2, ts: ask.ts, kind: "edited" },
  ]);
});

test("a late original never overwrites the edit that arrived before it", async () => {
  const database = await openLedger();
  await store(database, edit);

  expect((await store(database, ask)).decision).toEqual({ kind: "ignore", reason: "older" });
  expect(await readMessages(database)).toMatchObject([{ text: edit.text, version: edit.version }]);
  expect(await readChanges(database)).toEqual([{ seq: 1, ts: ask.ts, kind: "new" }]);
});

test("a newer version that says the same thing moves the version without a change", async () => {
  const database = await openLedger();
  await store(database, ask);

  const stored = await store(database, { ...ask, editedTs: edit.editedTs, version: edit.version });
  expect(stored.decision).toEqual({ kind: "update", change: null });
  expect(await readMessages(database)).toMatchObject([
    { text: ask.text, version: edit.version, updated_seq: 1 },
  ]);
  expect(await readChanges(database)).toHaveLength(1);
});

test("a delete drops the content for good, and every later version is ignored", async () => {
  const database = await openLedger();
  await store(database, ask);

  expect((await storeDeleteOf(database, ask)).decision).toEqual({
    kind: "update",
    change: "deleted",
  });
  expect((await store(database, edit)).decision).toEqual({ kind: "ignore", reason: "tombstoned" });
  expect((await storeDeleteOf(database, ask)).decision).toEqual({
    kind: "ignore",
    reason: "duplicate",
  });
  expect(await readMessages(database)).toEqual([
    {
      ts: ask.ts,
      eligible: 1,
      author_role: "owner",
      text: null,
      files: null,
      hashed: 0,
      mentions_bot: 0,
      deleted: 1,
      version: ask.version,
      updated_seq: 2,
    },
  ]);
  expect(await readChanges(database)).toEqual([
    { seq: 1, ts: ask.ts, kind: "new" },
    { seq: 2, ts: ask.ts, kind: "deleted" },
  ]);
});

test("a delete the ledger sees first leaves a tombstone its late original can't undo", async () => {
  const database = await openLedger();

  expect((await storeDeleteOf(database, ask)).decision).toEqual({
    kind: "insert",
    change: "deleted",
  });
  expect((await store(database, ask)).decision).toEqual({ kind: "ignore", reason: "tombstoned" });
  expect(await readMessages(database)).toEqual([
    {
      ts: ask.ts,
      eligible: 0,
      author_role: "other",
      text: null,
      files: null,
      hashed: 0,
      mentions_bot: 0,
      deleted: 1,
      version: ask.ts,
      updated_seq: 1,
    },
  ]);
  expect(await readChanges(database)).toEqual([{ seq: 1, ts: ask.ts, kind: "deleted" }]);
});

test("someone not on the allowlist keeps their text only in a request's thread", async () => {
  const database = await openLedger();
  const elsewhere = rootAt(aside, "1700000400.000100");
  await track(database, ask);

  await store(database, aside);
  await store(database, elsewhere);
  expect(await readMessages(database)).toMatchObject([
    { ts: aside.ts, eligible: 1, author_role: "observed", text: aside.text, hashed: 1 },
    { ts: elsewhere.ts, eligible: 1, author_role: "observed", text: null, hashed: 0 },
  ]);
});

test("a link that observes the whole channel keeps everyone's text", async () => {
  const database = await openLedger();
  const channel = { ...link, audience: { ...link.audience, observe: "channel" as const } };

  await store(database, aside, channel);
  expect(await readMessages(database)).toMatchObject([
    { author_role: "observed", text: aside.text },
  ]);
});

test("a marker fills in without a change once its thread becomes a request's", async () => {
  const database = await openLedger();
  await store(database, aside);
  await track(database, ask);

  const stored = await store(database, aside);
  expect(stored).toMatchObject({ decision: { kind: "update", change: null }, mentionedBot: false });
  expect(await readMessages(database)).toMatchObject([
    { text: aside.text, hashed: 1, updated_seq: 1 },
  ]);
  expect(await readChanges(database)).toEqual([{ seq: 1, ts: aside.ts, kind: "new" }]);
});

test("another bot's message is only ever a marker, and the bridge's own is kept", async () => {
  const database = await openLedger();
  const ci = { ...ask, author: "bot" as const, userId: "U-ci" };
  const own = { ...rootAt(ask, "1700000500.000100"), author: "self" as const, userId: "U-bot" };

  await store(database, ci);
  await store(database, own);
  expect(await readMessages(database)).toMatchObject([
    { ts: ask.ts, eligible: 0, author_role: "other", text: null, mentions_bot: 0 },
    { ts: own.ts, eligible: 0, author_role: "self", text: own.text, mentions_bot: 1 },
  ]);
});

test("a version stored after an allowlist change takes the author's new role", async () => {
  const database = await openLedger();
  const removed = { ...link, audience: { ...link.audience, allowlist: new Set<string>() } };
  const theirs = { ...ask, userId: "U-allowed", files: [file("F1")] };
  await store(database, theirs);
  await fetchFile(database, "F1");

  const stored = await store(database, { ...edit, userId: "U-allowed" }, removed);
  expect(stored).toMatchObject({
    decision: { kind: "update", change: "edited" },
    role: "observed",
    contentHash: null,
    purged: ["F1.png"],
  });
  expect(await readMessages(database)).toMatchObject([
    { author_role: "observed", text: null, mentions_bot: 0, updated_seq: 2 },
  ]);
  expect(await readFiles(database)).toEqual([]);
});

test("a kept message indexes its files, and an edit forgets the ones it drops", async () => {
  const database = await openLedger();
  await store(database, { ...ask, files: [file("F1"), file("F2")] });
  await fetchFile(database, "F2");

  const stored = await store(database, { ...edit, files: [file("F1")] });
  expect(stored.purged).toEqual(["F2.png"]);
  expect(await readFiles(database)).toEqual([
    { file_id: "F1", ts: ask.ts, state: "indexed", local_path: null },
  ]);
});

test("a file shared again follows the newest message without losing its local copy", async () => {
  const database = await openLedger();
  const again = { ...rootAt(ask, "1700000600.000100"), files: [file("F1")] };
  await store(database, { ...ask, files: [file("F1")] });
  await fetchFile(database, "F1");

  await store(database, again);
  expect(await readFiles(database)).toEqual([
    { file_id: "F1", ts: again.ts, state: "fetched", local_path: "F1.png" },
  ]);
});

test("a deleted message forgets its files and hands back their local copies", async () => {
  const database = await openLedger();
  await store(database, { ...ask, files: [file("F1"), file("F2")] });
  await fetchFile(database, "F1");

  expect((await storeDeleteOf(database, ask)).purged).toEqual(["F1.png"]);
  expect(await readFiles(database)).toEqual([]);
});

test("a tracked thread's newest reply only moves forward", async () => {
  const database = await openLedger();
  const latest = () =>
    database.read((sql) => sql`SELECT thread_ts, latest_reply_ts FROM threads ORDER BY thread_ts`);
  const later = { ...aside, ts: "1700000900.000100", version: "1700000900.000100" };
  await store(database, ask);
  await track(database, ask);

  await store(database, later);
  await store(database, aside);
  await database.write((transaction) => noteReply(transaction, "C-link", ask.ts, aside.ts));
  expect(await latest()).toEqual([{ thread_ts: ask.ts, latest_reply_ts: later.ts }]);

  // History returns the unchanged root with its newest reply.
  const root = await store(database, { ...ask, latestReplyTs: "1700001000.000100" });
  expect(root.decision).toEqual({ kind: "ignore", reason: "duplicate" });
  expect(await latest()).toEqual([{ thread_ts: ask.ts, latest_reply_ts: "1700001000.000100" }]);
});

test("a reply in a thread the bridge doesn't track leaves threads alone", async () => {
  const database = await openLedger();

  await store(database, aside);
  await store(database, { ...ask, latestReplyTs: aside.ts });
  await database.write((transaction) => noteReply(transaction, "C-link", ask.ts, aside.ts));
  expect(await database.read((sql) => sql`SELECT * FROM threads`)).toEqual([]);
});

test("a request's thread is tracked, and hydrated once if it holds other messages", async () => {
  const database = await openLedger();
  const threads = () =>
    database.read((sql) => sql`SELECT thread_ts, latest_reply_ts FROM threads ORDER BY thread_ts`);
  const gaps = () =>
    database.read(
      (sql) => sql`
        SELECT channel_id, scope, thread_ts, oldest_ts, latest_ts, state, reason, opened_at
        FROM coverage ORDER BY id
      `,
    );
  const root = rootAt(ask, "1700000700.000100");
  const reply = { ...aside, ts: "1700000800.000100", threadTs: root.ts, rootTs: root.ts };
  const answered = { ...rootAt(ask, "1700000900.000100"), latestReplyTs: "1700000950.000100" };

  // A fresh root holds nothing else, and a second request in a thread hydrates nothing more.
  await track(database, ask);
  await track(database, aside);
  expect(await gaps()).toEqual([]);

  await track(database, reply);
  await track(database, answered, 1_700_002_000_000);
  expect(await threads()).toEqual([
    { thread_ts: ask.ts, latest_reply_ts: null },
    { thread_ts: root.ts, latest_reply_ts: reply.ts },
    { thread_ts: answered.ts, latest_reply_ts: "1700000950.000100" },
  ]);
  expect(await gaps()).toEqual([
    {
      channel_id: "C-link",
      scope: "thread",
      thread_ts: root.ts,
      oldest_ts: root.ts,
      latest_ts: "1700001300.000000",
      state: "open",
      reason: "thread",
      opened_at: 1_700_001_000_000,
    },
    {
      channel_id: "C-link",
      scope: "thread",
      thread_ts: answered.ts,
      oldest_ts: answered.ts,
      latest_ts: "1700002300.000000",
      state: "open",
      reason: "thread",
      opened_at: 1_700_002_000_000,
    },
  ]);
});

function file(id: string) {
  return { id, name: `${id}.png`, mimetype: "image/png", size: 2048 };
}

/** Marks a file fetched, the way the file command records its local copy. */
function fetchFile(database: BridgeDatabase, fileId: string) {
  return database.write(
    (transaction) => transaction`
      UPDATE files SET state = 'fetched', local_path = ${`${fileId}.png`}, fetched_at = 1
      WHERE file_id = ${fileId}
    `,
  );
}

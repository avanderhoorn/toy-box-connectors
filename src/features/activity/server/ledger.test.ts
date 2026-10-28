import { expect, test } from "bun:test";
import type { LinkAudience } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { storeDelete, storeMessage } from "./ledger";
import { ledgerLink } from "./testFixtures";

const ask = askMessage();

async function openLedger(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
}

function store(
  database: BridgeDatabase,
  message: SlackMessage,
  { inRequestThread = false, observe = "requesters" as LinkAudience["observe"] } = {},
) {
  return database.write((transaction) =>
    storeMessage(transaction, ledgerLink({ observe }), message, inRequestThread),
  );
}

function storeDeleteOf(database: BridgeDatabase, message: SlackMessage) {
  return database.write((transaction) =>
    storeDelete(transaction, "link", message.channelId, message.ts),
  );
}

function readLedger(database: BridgeDatabase) {
  return database.read(async (sql) => ({
    messages: await sql`SELECT ts, text, deleted, updated_seq FROM messages ORDER BY ts`,
    changes: await sql`SELECT seq, ts, kind FROM changes ORDER BY seq`,
  }));
}

test("a message's versions converge in any order, with one change for each edit", async () => {
  const database = await openLedger();
  const edited = editMessage(ask, "1700000150.000100", "<@U-bot> can you look at prod?");
  for (const message of [ask, edited, ask, edited]) await store(database, message);

  expect(await readLedger(database)).toEqual({
    messages: [{ ts: ask.ts, text: edited.text, deleted: 0, updated_seq: 2 }],
    changes: [
      { seq: 1, ts: ask.ts, kind: "new" },
      { seq: 2, ts: ask.ts, kind: "edited" },
    ],
  });
});

test("a delete forgets a message's text for good, even when it arrives first", async () => {
  const database = await openLedger();
  const early = askMessage("1700000200.000100");
  await store(database, ask);
  for (const message of [ask, early]) {
    await storeDeleteOf(database, message);
    await storeDeleteOf(database, message);
    await store(database, message);
  }

  expect(await readLedger(database)).toEqual({
    messages: [
      { ts: ask.ts, text: null, deleted: 1, updated_seq: 2 },
      { ts: early.ts, text: null, deleted: 1, updated_seq: 3 },
    ],
    changes: [
      { seq: 1, ts: ask.ts, kind: "new" },
      { seq: 2, ts: ask.ts, kind: "deleted" },
      { seq: 3, ts: early.ts, kind: "deleted" },
    ],
  });
});

test("a stranger's text is kept only where the link observes them, and another bot's never", async () => {
  const database = await openLedger();
  const said = (ts: string, changes = {}) =>
    askMessage(ts, {
      userId: "U-stranger",
      text: "it's red",
      mentions: [],
      mentionsBot: false,
      ...changes,
    });
  const inThread = replyMessage(ask, "1700000200.000100", { userId: "U-stranger" });
  await store(database, inThread);
  // A request started in the thread since, so its redelivery fills the marker in.
  await store(database, inThread, { inRequestThread: true });
  await store(database, said("1700000300.000100"));
  await store(database, said("1700000400.000100"), { observe: "channel" });
  await store(database, said("1700000500.000100", { author: "bot" }), {
    inRequestThread: true,
    observe: "channel",
  });

  expect(
    await database.read(
      (sql) => sql`SELECT ts, author_role, text IS NOT NULL AS kept FROM messages ORDER BY ts`,
    ),
  ).toEqual([
    { ts: inThread.ts, author_role: "observed", kept: 1 },
    { ts: "1700000300.000100", author_role: "observed", kept: 0 },
    { ts: "1700000400.000100", author_role: "observed", kept: 1 },
    { ts: "1700000500.000100", author_role: "other", kept: 0 },
  ]);
  const kinds = (await readLedger(database)).changes.map((change: { kind: string }) => change.kind);
  expect(kinds).toEqual(["new", "new", "new", "new"]);
});

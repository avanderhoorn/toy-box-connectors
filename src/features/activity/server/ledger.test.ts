import { expect, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { forgetOldActivity, storeDelete } from "./ledger";
import { createStoredMessage, linkAudience } from "./testFixtures";

const ask = askMessage();

async function openLedger(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
}

function storeDeleteOf(database: BridgeDatabase, message: SlackMessage) {
  return database.write((transaction) => storeDelete(transaction, message.channelId, message.ts));
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
  for (const message of [ask, edited, ask, edited]) await createStoredMessage(database, message);

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
  await createStoredMessage(database, ask);
  for (const message of [ask, early]) {
    await storeDeleteOf(database, message);
    await storeDeleteOf(database, message);
    await createStoredMessage(database, message);
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

test("a stranger's text is kept only where the link observes them", async () => {
  const database = await openLedger();
  const inThread = replyMessage(ask, "1700000200.000100", { userId: "U-stranger" });
  const atRoot = askMessage("1700000300.000100", { userId: "U-stranger", text: inThread.text });
  await createStoredMessage(database, inThread);
  // A request started in the thread since, so its redelivery fills the marker in.
  await createStoredMessage(database, inThread, linkAudience(), true);
  await createStoredMessage(database, atRoot);
  await createStoredMessage(
    database,
    { ...atRoot, ts: "1700000400.000100" },
    linkAudience({ observe: "channel" }),
  );

  expect((await readLedger(database)).messages).toEqual([
    { ts: inThread.ts, text: inThread.text, deleted: 0, updated_seq: 1 },
    { ts: atRoot.ts, text: null, deleted: 0, updated_seq: 2 },
    { ts: "1700000400.000100", text: inThread.text, deleted: 0, updated_seq: 3 },
  ]);
});

test("the ledger keeps who wrote a message only while it keeps what they said", async () => {
  const database = await openLedger();
  const stranger = askMessage("1700000200.000100", { userId: "U-stranger" });
  const deleted = askMessage("1700000300.000100");
  for (const message of [ask, stranger, deleted]) await createStoredMessage(database, message);
  await storeDeleteOf(database, deleted);
  await storeDeleteOf(database, askMessage("1700000400.000100"));

  expect(await database.read((sql) => sql`SELECT ts, user_id FROM messages ORDER BY ts`)).toEqual([
    { ts: ask.ts, user_id: "U-owner" },
    { ts: stranger.ts, user_id: null },
    { ts: deleted.ts, user_id: null },
    { ts: "1700000400.000100", user_id: null },
  ]);
});

test("the ledger forgets a message 30 days after its latest version, and a tombstone too", async () => {
  const database = await openLedger();
  const edited = editMessage(askMessage("1700000050.000100"), "1700000300.000100", "it's red");
  for (const message of [ask, edited]) await createStoredMessage(database, message);
  await storeDeleteOf(database, askMessage("1700000060.000100"));
  const now = 1_700_000_200_000 + RETENTION_MS;
  await database.write((transaction) => forgetOldActivity(transaction, now));

  expect((await readLedger(database)).messages).toEqual([
    { ts: edited.ts, text: edited.text, deleted: 0, updated_seq: 2 },
  ]);
});

test("only the change a kept message points at stays, and no seq is handed out again", async () => {
  const database = await openLedger();
  const edited = editMessage(ask, "1700000300.000100", "<@U-bot> can you look at prod?");
  for (const message of [askMessage("1700000050.000100"), ask, edited]) {
    await createStoredMessage(database, message);
  }
  const now = 1_700_000_200_000 + RETENTION_MS;
  await database.write((transaction) => forgetOldActivity(transaction, now));
  expect((await readLedger(database)).changes).toEqual([{ seq: 3, ts: ask.ts, kind: "edited" }]);

  await database.write((transaction) => forgetOldActivity(transaction, now + RETENTION_MS));
  await createStoredMessage(database, askMessage("1705000000.000100"));
  expect((await readLedger(database)).changes).toEqual([
    { seq: 4, ts: "1705000000.000100", kind: "new" },
  ]);
});

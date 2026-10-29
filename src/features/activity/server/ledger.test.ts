import { expect, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { forgetOldMessages, storeDelete } from "./ledger";
import { createStoredMessage, ledgerLink } from "./testFixtures";

const ask = askMessage();

async function openLedger(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
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
  await createStoredMessage(database, inThread, ledgerLink(), true);
  await createStoredMessage(database, atRoot);
  await createStoredMessage(
    database,
    { ...atRoot, ts: "1700000400.000100" },
    ledgerLink({ observe: "channel" }),
  );

  expect((await readLedger(database)).messages).toEqual([
    { ts: inThread.ts, text: inThread.text, deleted: 0, updated_seq: 1 },
    { ts: atRoot.ts, text: null, deleted: 0, updated_seq: 2 },
    { ts: "1700000400.000100", text: inThread.text, deleted: 0, updated_seq: 3 },
  ]);
});

test("the ledger forgets a message 30 days after its latest version, and a tombstone too", async () => {
  const database = await openLedger();
  const edited = editMessage(askMessage("1700000050.000100"), "1700000300.000100", "it's red");
  for (const message of [ask, edited]) await createStoredMessage(database, message);
  await storeDeleteOf(database, askMessage("1700000060.000100"));
  const now = 1_700_000_200_000 + RETENTION_MS;
  await database.write((transaction) => forgetOldMessages(transaction, now));

  const { messages, changes } = await readLedger(database);
  expect(messages.map((message: { ts: string }) => message.ts)).toEqual([edited.ts]);
  expect(changes).toHaveLength(3);
});

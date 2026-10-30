import { expect, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, editMessage, replyMessage, sharedFile } from "@slackapi/model/testFixtures";
import { forgetOldActivity, storeDelete } from "./ledger";
import { createStoredMessage, linkAudience } from "./testFixtures";

const ask = askMessage("1700000100.000100", { files: [sharedFile("F1")] });

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
    files: await sql`SELECT id, ts, file_id, whole FROM message_files ORDER BY id`,
  }));
}

test("a delete forgets a message's text and files for good, even when it arrives first", async () => {
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
    files: [],
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

test("a file keeps its reference through edits while its message shares it and the ledger keeps its text", async () => {
  const database = await openLedger();
  const [f1, f2, f3] = [sharedFile("F1"), sharedFile("F2"), sharedFile("F3")];
  await createStoredMessage(database, { ...ask, files: [{ id: "F1", whole: false }, f2] });
  const recaptioned = editMessage({ ...ask, files: [f1, f2] }, "1700000200.000100", "the log too");
  await createStoredMessage(database, recaptioned);
  expect((await readLedger(database)).files).toEqual([
    { id: 1, ts: ask.ts, file_id: "F1", whole: 1 },
    { id: 2, ts: ask.ts, file_id: "F2", whole: 1 },
  ]);

  const swapped = { ...editMessage(recaptioned, "1700000300.000100", "the log"), files: [f2, f3] };
  await createStoredMessage(database, swapped);
  expect((await readLedger(database)).files).toEqual([
    { id: 2, ts: ask.ts, file_id: "F2", whole: 1 },
    { id: 3, ts: ask.ts, file_id: "F3", whole: 1 },
  ]);

  // Its author left the allowlist, so the ledger keeps only a marker of their next edit.
  const unallowed = linkAudience({ allowlist: new Set(["U-allowed"]) });
  await createStoredMessage(database, editMessage(swapped, "1700000400.000100", "ok"), unallowed);
  expect((await readLedger(database)).files).toEqual([]);
});

test("the ledger forgets a message and its files 30 days after its latest version, and a tombstone too", async () => {
  const database = await openLedger();
  const original = askMessage("1700000050.000100", { files: [sharedFile("F2")] });
  const edited = editMessage(original, "1700000300.000100", "it's red");
  for (const message of [ask, edited]) await createStoredMessage(database, message);
  await storeDeleteOf(database, askMessage("1700000060.000100"));
  const now = 1_700_000_200_000 + RETENTION_MS;
  await database.write((transaction) => forgetOldActivity(transaction, now));

  const ledger = await readLedger(database);
  expect(ledger.messages).toEqual([
    { ts: edited.ts, text: edited.text, deleted: 0, updated_seq: 2 },
  ]);
  expect(ledger.files).toEqual([{ id: 2, ts: edited.ts, file_id: "F2", whole: 1 }]);
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

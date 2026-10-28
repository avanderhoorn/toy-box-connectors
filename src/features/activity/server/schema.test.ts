import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";

/** Store an open channel-wide coverage gap unless `gap` says otherwise. */
function insertGap(database: BridgeDatabase, gap: Record<string, unknown>) {
  const row = {
    link_id: "link",
    channel_id: "C-link",
    scope: "channel",
    oldest_ts: "1700000000.000100",
    latest_ts: "1700000600.000200",
    state: "open",
    reason: "disconnect",
    opened_at: 0,
    ...gap,
  };
  return database.write((transaction) => transaction`INSERT INTO coverage ${transaction(row)}`);
}

/** Store the owner's kept message unless `message` says otherwise. */
function insertMessage(database: BridgeDatabase, message: Record<string, unknown>) {
  const row = {
    channel_id: "C-link",
    ts: "1700000100.000100",
    user_id: "U-owner",
    team_id: "T0123",
    eligible: 1,
    author_role: "owner",
    text: "Can you look at the deploy?",
    files: "[]",
    content_hash: "hash",
    version: "1700000100.000100",
    updated_seq: 1,
    ...message,
  };
  return database.write((transaction) => transaction`INSERT INTO messages ${transaction(row)}`);
}

/** Store an indexed file of the owner's message unless `file` says otherwise. */
function insertFile(database: BridgeDatabase, file: Record<string, unknown>) {
  const row = {
    file_id: "F0123",
    channel_id: "C-link",
    ts: "1700000100.000100",
    state: "indexed",
    size: 2048,
    mime: "image/png",
    ...file,
  };
  return database.write((transaction) => transaction`INSERT INTO files ${transaction(row)}`);
}

test("a message is eligible to start a request exactly when a person wrote it", async () => {
  const database = await openTestDatabase();
  const eligibility =
    "CHECK constraint failed: eligible = (author_role IN ('owner', 'allowed', 'observed'))";

  await insertMessage(database, { ts: "1700000100.000100", author_role: "observed" });
  await insertMessage(database, { ts: "1700000100.000200", author_role: "self", eligible: 0 });
  await expect(
    insertMessage(database, { ts: "1700000100.000300", author_role: "self" }),
  ).rejects.toThrow(eligibility);
  await expect(
    insertMessage(database, { ts: "1700000100.000400", author_role: "allowed", eligible: 0 }),
  ).rejects.toThrow(eligibility);
});

test("a message keeps its text, files and content hash together or none of them", async () => {
  const database = await openTestDatabase();
  const marker = { text: null, files: null, content_hash: null };

  await insertMessage(database, { ts: "1700000100.000100" });
  await insertMessage(database, { ts: "1700000100.000200", ...marker });
  await expect(
    insertMessage(database, { ts: "1700000100.000300", content_hash: null }),
  ).rejects.toThrow("CHECK constraint failed: (content_hash IS NULL) = (text IS NULL)");
  await expect(
    insertMessage(database, { ts: "1700000100.000400", ...marker, files: "[]" }),
  ).rejects.toThrow("CHECK constraint failed: (files IS NULL) = (text IS NULL)");
});

test("only a message whose text the ledger keeps remembers mentioning the bot", async () => {
  const database = await openTestDatabase();
  const marker = { text: null, files: null, content_hash: null };

  await insertMessage(database, { ts: "1700000100.000100", mentions_bot: 1 });
  await insertMessage(database, { ts: "1700000100.000200", ...marker });
  await expect(
    insertMessage(database, { ts: "1700000100.000300", ...marker, mentions_bot: 1 }),
  ).rejects.toThrow("CHECK constraint failed: text IS NOT NULL OR mentions_bot = 0");
});

test("a deleted message, and one that no person or the bridge wrote, keeps no content", async () => {
  const database = await openTestDatabase();
  const marker = { text: null, files: null, content_hash: null };
  const contentFree =
    "CHECK constraint failed: text IS NULL OR (deleted = 0 AND author_role <> 'other')";

  await insertMessage(database, { ts: "1700000100.000100", deleted: 1, ...marker });
  await insertMessage(database, {
    ts: "1700000100.000200",
    author_role: "other",
    eligible: 0,
    ...marker,
  });
  await expect(insertMessage(database, { ts: "1700000100.000300", deleted: 1 })).rejects.toThrow(
    contentFree,
  );
  await expect(
    insertMessage(database, { ts: "1700000100.000400", author_role: "other", eligible: 0 }),
  ).rejects.toThrow(contentFree);
});

test("a file has a local copy and a fetch time exactly when it was fetched", async () => {
  const database = await openTestDatabase();
  const fetched = { state: "fetched", local_path: "F0123.png", fetched_at: 1 };

  await insertFile(database, { file_id: "F0001" });
  await insertFile(database, { file_id: "F0002", ...fetched });
  await expect(insertFile(database, { ...fetched, local_path: null })).rejects.toThrow(
    "CHECK constraint failed: (local_path IS NOT NULL) = (state = 'fetched')",
  );
  await expect(insertFile(database, { ...fetched, fetched_at: null })).rejects.toThrow(
    "CHECK constraint failed: (fetched_at IS NOT NULL) = (state = 'fetched')",
  );
  await expect(insertFile(database, { local_path: "F0123.png" })).rejects.toThrow(
    "CHECK constraint failed: (local_path IS NOT NULL) = (state = 'fetched')",
  );
});

test("a cursor never marks read past what activity served", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await database.write(
    (transaction) =>
      transaction`INSERT INTO cursors (link_id, served_through_seq) VALUES ('link', 5)`,
  );

  await database.write((transaction) => transaction`UPDATE cursors SET through_seq = 5`);
  await expect(
    database.write((transaction) => transaction`UPDATE cursors SET through_seq = 6`),
  ).rejects.toThrow("CHECK constraint failed: through_seq <= served_through_seq");
});

test("a coverage gap names a thread exactly when it covers one", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const pairing = "CHECK constraint failed: (thread_ts IS NOT NULL) = (scope = 'thread')";

  await insertGap(database, { scope: "channel" });
  await insertGap(database, { scope: "thread", thread_ts: "1700000000.000100" });
  await expect(insertGap(database, { scope: "thread" })).rejects.toThrow(pairing);
  await expect(
    insertGap(database, { scope: "channel", thread_ts: "1700000000.000100" }),
  ).rejects.toThrow(pairing);
});

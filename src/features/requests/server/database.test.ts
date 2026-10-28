import { expect, test } from "bun:test";
import { storeDelete } from "@activity/server/ledger";
import { createStoredMessage } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import {
  cancelRequest,
  dismissRequest,
  openRequest,
  type Request,
} from "@requests/model/lifecycle";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import type { SlackTs } from "@slackapi/model/ts";
import {
  askedBefore,
  assignRequestMessage,
  hashInput,
  insertRequest,
  moveRequestChannel,
  readActiveRequest,
  readInputHash,
  readMessageRequest,
  readRequest,
  saveRequest,
} from "./database";
import { createStoredRequest } from "./testFixtures";

const ask = askMessage();
const more = replyMessage(ask, "1700000200.000100");

function assign(database: BridgeDatabase, requestId: number, ts: SlackTs, channelId = "C-link") {
  return database.write((transaction) =>
    assignRequestMessage(transaction, requestId, channelId, ts),
  );
}

test("a request reads back exactly as it was saved", async () => {
  const database = await openTestDatabase();
  const working: Request = {
    ...openRequest(
      {
        linkId: "link",
        channelId: "C-link",
        rootTs: ask.ts,
        sourceTs: more.ts,
        requesterUserId: "U-allowed",
        reason: "follow_up",
        inputHash: "hash-3",
        late: true,
      },
      1_000,
    ),
    state: "in_progress",
    inputRev: 3,
    servedRev: 2,
    attention: "updated",
    sourceUnverifiedAt: 2_000,
    heldAt: 3_000,
    holdReason: "asked the owner",
    changedAt: 4_000,
    seenAt: 5_000,
    touchedAt: 6_000,
    remindedAt: 7_000,
    progressTs: "1700000300.000100",
  };

  const stored = await database.write((transaction) => insertRequest(transaction, working));
  const other = await createStoredRequest(database);
  expect(stored).toEqual({ ...working, id: 1 });
  expect(await database.read((sql) => readRequest(sql, 1))).toEqual(stored);

  const dismissed = dismissRequest(stored, "answered in standup");
  await database.write((transaction) => saveRequest(transaction, dismissed));
  expect(await database.read((sql) => readRequest(sql, 1))).toEqual(dismissed);
  expect(await database.read((sql) => readRequest(sql, other.id))).toEqual(other);
  expect(await database.read((sql) => readRequest(sql, 3))).toBeNull();
});

test("a person's active request in a thread is the one their later messages there join", async () => {
  const database = await openTestDatabase();
  const later = "1700000300.000100";
  await createStoredRequest(database, { state: "answered", seenAt: 1 });
  const active = await createStoredRequest(database, {
    sourceTs: more.ts,
    state: "seen",
    seenAt: 1,
  });
  await createStoredRequest(database, { requesterUserId: "U-allowed" });
  await createStoredRequest(database, { rootTs: later, sourceTs: later });
  await createStoredRequest(database, { linkId: "other" });
  const activeId = async (userId: string, rootTs = ask.ts, linkId = "link") =>
    (await database.read((sql) => readActiveRequest(sql, linkId, userId, rootTs)))?.id;

  expect(await database.read((sql) => readActiveRequest(sql, "link", "U-owner", ask.ts))).toEqual(
    active,
  );
  expect(await activeId("U-allowed")).toBe(3);
  expect(await activeId("U-owner", later)).toBe(4);
  expect(await activeId("U-owner", ask.ts, "other")).toBe(5);
  expect(await activeId("U-observed")).toBeUndefined();

  await database.write((transaction) =>
    saveRequest(transaction, cancelRequest(active, "source_deleted")),
  );
  expect(await activeId("U-owner")).toBeUndefined();
});

test("a message belongs to one request at a time, whatever its state", async () => {
  const database = await openTestDatabase();
  const answered = await createStoredRequest(database, { state: "answered", seenAt: 1 });
  const open = await createStoredRequest(database);
  const owner = (ts: SlackTs, channelId = "C-link") =>
    database.read((sql) => readMessageRequest(sql, channelId, ts));

  await assign(database, answered.id, ask.ts);
  await assign(database, answered.id, ask.ts);
  expect(await owner(ask.ts)).toEqual(answered);
  expect(await owner(more.ts)).toBeNull();
  expect(await owner(ask.ts, "C-other")).toBeNull();

  await assign(database, open.id, ask.ts);
  expect(await owner(ask.ts)).toEqual(open);
  expect(await database.read((sql) => sql`SELECT * FROM request_messages`)).toEqual([
    { request_id: open.id, channel_id: "C-link", ts: ask.ts },
  ]);
});

test("a channel Slack gave a new ID keeps its requests and their messages under the new one", async () => {
  const database = await openTestDatabase();
  const moving = await createStoredRequest(database);
  const staying = await createStoredRequest(database, {
    channelId: "C-other",
    requesterUserId: "U-allowed",
  });
  await assign(database, moving.id, ask.ts);
  await assign(database, moving.id, more.ts);
  await assign(database, staying.id, ask.ts, "C-other");

  await database.write((transaction) => moveRequestChannel(transaction, "C-link", "C-new"));

  expect(await database.read((sql) => readRequest(sql, moving.id))).toEqual({
    ...moving,
    channelId: "C-new",
  });
  expect(await database.read((sql) => readRequest(sql, staying.id))).toEqual(staying);
  expect(
    await database.read(
      (sql) => sql`SELECT request_id, channel_id, ts FROM request_messages ORDER BY channel_id, ts`,
    ),
  ).toEqual([
    { request_id: moving.id, channel_id: "C-new", ts: ask.ts },
    { request_id: moving.id, channel_id: "C-new", ts: more.ts },
    { request_id: staying.id, channel_id: "C-other", ts: ask.ts },
  ]);
});

test("whether someone asked before looks back from a ts, ordered as a number", async () => {
  const database = await openTestDatabase();
  // As text, the request's source sorts after every ts from a second later.
  const root = "999999999.000100";
  await createStoredRequest(database, {
    rootTs: root,
    sourceTs: "999999999.500000",
    state: "answered",
    seenAt: 1,
  });
  const asked = (ts: SlackTs, userId = "U-owner", rootTs = root, linkId = "link") =>
    database.read((sql) => askedBefore(sql, linkId, userId, rootTs, ts));

  expect(await asked("1000000000.000000")).toBe(true);
  expect(await asked("999999999.500000")).toBe(false);
  expect(await asked("999999999.400000")).toBe(false);
  expect(await asked("1000000000.000000", "U-allowed")).toBe(false);
  expect(await asked("1000000000.000000", "U-owner", "999999999.000200")).toBe(false);
  expect(await asked("1000000000.000000", "U-owner", root, "other")).toBe(false);
});

test("a request's input hash covers the messages it still has, in ts order", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const first = await createStoredMessage(database, ask);
  const second = await createStoredMessage(database, more);
  const request = await createStoredRequest(database);
  const other = await createStoredRequest(database, { requesterUserId: "U-allowed" });
  await assign(database, request.id, more.ts);
  await assign(database, request.id, ask.ts);
  await createStoredMessage(database, askMessage("1700000300.000100", { userId: "U-allowed" }));
  await assign(database, other.id, "1700000300.000100");
  const inputHash = () => database.read((sql) => readInputHash(sql, request.id));

  expect(await inputHash()).toBe(
    hashInput([
      { ts: ask.ts, deleted: false, contentHash: first.contentHash },
      { ts: more.ts, deleted: false, contentHash: second.contentHash },
    ]),
  );

  const edited = await createStoredMessage(
    database,
    editMessage(ask, "1700000150.000100", "<@U-bot> can you look at the staging deploy?"),
  );
  await database.write((transaction) => storeDelete(transaction, "link", "C-link", more.ts));
  expect(await inputHash()).toBe(
    hashInput([{ ts: ask.ts, deleted: false, contentHash: edited.contentHash }]),
  );
  expect(edited.contentHash).not.toBe(first.contentHash);
});

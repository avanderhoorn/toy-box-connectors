import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import {
  cancelQueuedRequestItems,
  forgetLinkOutbox,
  moveOutboxChannel,
  queueItem,
  queueReaction,
} from "./database";
import { createStoredOutboxItem } from "./testFixtures";

test("cancelling a request's items takes back only its queued replies and progress", async () => {
  const database = await openTestDatabase();
  await createStoredOutboxItem(database, 1);
  await createStoredOutboxItem(database, 2, { kind: "progress", phase: null });
  await createStoredOutboxItem(database, 3, { phase: "follow_up", state: "sending" });
  await createStoredOutboxItem(database, 4, { kind: "reaction", phase: null, request_rev: null });
  await createStoredOutboxItem(database, 5, { request_id: 2 });

  await database.write((transaction) => cancelQueuedRequestItems(transaction, 1, 60_000));
  expect(
    await database.read((sql) => sql`SELECT number, state, updated_at FROM outbox ORDER BY number`),
  ).toEqual([
    { number: 1, state: "cancelled", updated_at: 60_000 },
    { number: 2, state: "cancelled", updated_at: 60_000 },
    { number: 3, state: "sending", updated_at: 0 },
    { number: 4, state: "queued", updated_at: 0 },
    { number: 5, state: "queued", updated_at: 0 },
  ]);
});

test("a channel's new ID readdresses every item for it, sent or not, and nothing else", async () => {
  const database = await openTestDatabase();
  await createStoredOutboxItem(database, 1);
  await createStoredOutboxItem(database, 2, {
    request_id: 2,
    state: "sent",
    slack_ts: "1700000200.000100",
  });
  await createStoredOutboxItem(database, 3, { request_id: 3, channel_id: "C-other" });

  await database.write((transaction) => moveOutboxChannel(transaction, "C-link", "C-new"));

  expect(
    await database.read(
      (sql) => sql`SELECT number, channel_id, state, updated_at FROM outbox ORDER BY number`,
    ),
  ).toEqual([
    { number: 1, channel_id: "C-new", state: "queued", updated_at: 0 },
    { number: 2, channel_id: "C-new", state: "sent", updated_at: 0 },
    { number: 3, channel_id: "C-other", state: "queued", updated_at: 0 },
  ]);
});

type QueuedRow = {
  number: number;
  link_id: string | null;
  kind: string;
  phase: string | null;
  channel_id: string;
  payload: string;
  payload_hash: string;
  state: string;
  created_at: number;
  updated_at: number;
};

function readQueued(database: BridgeDatabase) {
  return database.read(
    (sql) => sql<QueuedRow[]>`
      SELECT number, link_id, kind, phase, channel_id, payload, payload_hash, state,
        created_at, updated_at
      FROM outbox ORDER BY number
    `,
  );
}

test("a reaction is queued after every item before it, naming only its message and emoji", async () => {
  const database = await openTestDatabase();
  await createStoredOutboxItem(database, 7);

  await database.write((transaction) =>
    queueReaction(
      transaction,
      { channelId: "D-owner", ts: "1700000200.000100", name: "white_check_mark" },
      60_000,
    ),
  );

  const payload = '{"action":"add","name":"white_check_mark","timestamp":"1700000200.000100"}';
  expect((await readQueued(database))[1]).toEqual({
    number: 8,
    link_id: null,
    kind: "reaction",
    phase: null,
    channel_id: "D-owner",
    payload,
    payload_hash: Bun.SHA256.hash(payload, "hex"),
    state: "queued",
    created_at: 60_000,
    updated_at: 60_000,
  });
});

test.each(["sending", "delivery_unknown", "sent", "failed"])(
  "a reaction removal shares only a queued removal, never a %s one",
  async (state) => {
    const database = await openTestDatabase();
    const removal = {
      action: "remove",
      channelId: "C-link",
      ts: "1700000200.000100",
      name: "eyes",
      linkId: "link",
      requestId: 1,
    } as const;
    await database.write(async (tx) => {
      await queueReaction(tx, removal, 1_000);
      await queueReaction(tx, removal, 2_000);
    });
    expect(await readQueued(database)).toHaveLength(1);
    await database.write(async (tx) => {
      await tx`UPDATE outbox SET state = ${state}`;
      await queueReaction(tx, removal, 3_000);
    });
    expect((await readQueued(database)).map((item) => item.state)).toEqual([state, "queued"]);
  },
);

test("a queued add never absorbs the removal that must follow it", async () => {
  const database = await openTestDatabase();
  const reaction = {
    channelId: "C-link",
    ts: "1700000200.000100",
    name: "eyes",
  };
  await database.write(async (tx) => {
    await queueReaction(tx, reaction, 1_000);
    await queueReaction(tx, { ...reaction, action: "remove" }, 2_000);
  });
  expect(await readQueued(database)).toHaveLength(2);
});

test.each([
  { channelId: "C-other" },
  { ts: "1700000200.000200" },
  { name: "white_check_mark" },
  { linkId: "other" },
  { requestId: 2 },
  { action: "add" as const },
])("reaction removal coalescing keeps a different target or scope: %j", async (changes) => {
  const database = await openTestDatabase();
  const removal = {
    action: "remove",
    channelId: "C-link",
    ts: "1700000200.000100",
    name: "eyes",
    linkId: "link",
    requestId: 1,
  } as const;
  await database.write(async (tx) => {
    await queueReaction(tx, removal, 1_000);
    await queueReaction(tx, { ...removal, ...changes }, 2_000);
  });
  expect(await readQueued(database)).toHaveLength(2);
});

test("an item is queued with every column it names, and comes back as its ID and number", async () => {
  const database = await openTestDatabase();
  await createStoredOutboxItem(database, 3);

  const queued = await database.write((transaction) =>
    queueItem(
      transaction,
      {
        kind: "reply",
        phase: "final",
        linkId: "link",
        requestId: 14,
        requestRev: 2,
        channelId: "C-link",
        threadTs: "1700000100.000100",
        payload: { text: "Done" },
      },
      60_000,
    ),
  );

  expect(queued).toEqual({ id: expect.any(String), number: 4 });
  const [row] = await database.read((sql) => sql`SELECT * FROM outbox WHERE id = ${queued.id}`);
  expect(row).toMatchObject({
    number: 4,
    link_id: "link",
    request_id: 14,
    request_rev: 2,
    kind: "reply",
    phase: "final",
    channel_id: "C-link",
    thread_ts: "1700000100.000100",
    publication_key: null,
    replaces: null,
    payload: '{"text":"Done"}',
    payload_hash: Bun.SHA256.hash('{"text":"Done"}', "hex"),
    state: "queued",
    attempts: 0,
    created_at: 60_000,
    updated_at: 60_000,
  });
});

test("an item never takes the number of one deleted before it", async () => {
  const database = await openTestDatabase();
  await createStoredOutboxItem(database, 3);
  const queue = () =>
    database.write((transaction) =>
      queueItem(transaction, { kind: "progress", channelId: "C-link", payload: {} }, 60_000),
    );
  const newest = await queue();
  await database.write((transaction) => transaction`DELETE FROM outbox WHERE id = ${newest.id}`);

  expect(await queue()).toEqual({ id: expect.any(String), number: 5 });
});

/** Stores item `number` of the link, a final reply to request `number` unless `columns` differ. */
function storeItem(
  database: BridgeDatabase,
  number: number,
  columns: Record<string, string | number | null> = {},
) {
  return createStoredOutboxItem(database, number, { request_id: number, ...columns });
}

/** Stores item `number` saying `payload`, a follow-up unless `columns` differ. */
function storeSaying(
  database: BridgeDatabase,
  number: number,
  payload: object,
  columns: Record<string, string | number | null> = {},
) {
  const kind = columns.kind ?? "reply";
  const phase = kind === "reply" ? "follow_up" : null;
  return storeItem(database, number, { phase, payload: JSON.stringify(payload), ...columns });
}

/** Forgets the outbox of the link, as unlinking it a minute in does. */
function forgetLink(database: BridgeDatabase) {
  return database.write((transaction) => forgetLinkOutbox(transaction, "link", 60_000));
}

/** Each item's number, link, kind, state and payload, oldest first. */
async function readItems(database: BridgeDatabase) {
  const items = await database.read(
    (sql) => sql<StoredItem[]>`
      SELECT number, link_id, kind, state, payload FROM outbox ORDER BY number
    `,
  );
  return [...items];
}

type StoredItem = { number: number; link_id: string; kind: string; state: string; payload: string };

const said = { text: "The deploy failed at step 3." };
const redacted = JSON.stringify({ redacted: "unlink" });

test("a link that's going keeps only what Slack may still settle, and none of its text", async () => {
  const database = await openTestDatabase();
  const sending = { state: "sending", attempts: 1, attempt_method: "chat.postMessage" };
  const unknown = { state: "delivery_unknown", attempts: 1 };
  const eyes = { action: "add", name: "eyes", timestamp: "1700000100.000100" };
  const check = { ...eyes, name: "white_check_mark" };
  await storeSaying(database, 1, said, { phase: "final" });
  await storeSaying(database, 2, said, sending);
  await storeSaying(
    database,
    3,
    { ...said, ts: "1700000300.000100" },
    {
      ...unknown,
      kind: "progress",
      attempt_method: "chat.update",
    },
  );
  await storeSaying(
    database,
    4,
    { ...said, ts: "1700000300.000100" },
    {
      ...unknown,
      kind: "publication",
      publication_key: "release-notes-1",
      attempt_method: "chat.postMessage",
    },
  );
  await storeSaying(database, 5, said, { state: "sent", slack_ts: "1700000500.000100" });
  await storeSaying(database, 6, said, { state: "cancelled" });
  await storeSaying(database, 7, said, { state: "failed", error: "msg_too_long" });
  await storeSaying(database, 8, eyes, { kind: "reaction" });
  await storeSaying(database, 9, { ...eyes, action: "remove" }, { kind: "reaction" });
  await storeSaying(database, 10, check, {
    ...unknown,
    kind: "reaction",
    attempt_method: "reactions.add",
  });
  await storeSaying(database, 11, { status: "is looking into it…" }, { kind: "status" });
  await storeSaying(database, 12, { status: "" }, { kind: "status" });
  await storeSaying(
    database,
    13,
    { status: "is looking into it…" },
    {
      ...sending,
      kind: "status",
      attempt_method: "assistant.threads.setStatus",
    },
  );
  await storeSaying(database, 14, said, { link_id: "other", phase: "final" });

  await forgetLink(database);

  expect(await readItems(database)).toEqual([
    { number: 2, link_id: "link", kind: "reply", state: "sending", payload: redacted },
    {
      number: 3,
      link_id: "link",
      kind: "progress",
      state: "delivery_unknown",
      payload: JSON.stringify({ redacted: "unlink", ts: "1700000300.000100" }),
    },
    {
      number: 4,
      link_id: "link",
      kind: "publication",
      state: "delivery_unknown",
      payload: redacted,
    },
    {
      number: 9,
      link_id: "link",
      kind: "reaction",
      state: "queued",
      payload: JSON.stringify({ ...eyes, action: "remove" }),
    },
    {
      number: 10,
      link_id: "link",
      kind: "reaction",
      state: "delivery_unknown",
      payload: JSON.stringify(check),
    },
    { number: 12, link_id: "link", kind: "status", state: "queued", payload: '{"status":""}' },
    {
      number: 13,
      link_id: "link",
      kind: "status",
      state: "sending",
      payload: '{"status":"is looking into it…"}',
    },
    { number: 14, link_id: "other", kind: "reply", state: "queued", payload: JSON.stringify(said) },
  ]);
});

test("a withdrawal the link still owes goes out, with the post it withdraws", async () => {
  const database = await openTestDatabase();
  const sent = { state: "sent", slack_ts: "1700000100.000100" };
  await storeSaying(database, 1, said, { ...sent, kind: "publication", publication_key: "notes" });
  await storeSaying(database, 2, { target: "item-1" }, { kind: "retract" });
  await storeSaying(database, 3, said, sent);
  await storeSaying(database, 4, said, { ...sent, state: "retracted" });
  await storeSaying(database, 5, { target: "item-4" }, { kind: "retract" });
  await storeSaying(
    database,
    6,
    { target: "item-7" },
    {
      kind: "retract",
      state: "sending",
      attempts: 1,
      attempt_method: "chat.delete",
    },
  );
  await storeSaying(database, 7, said, sent);
  await storeSaying(database, 8, { target: "item-gone" }, { kind: "retract" });

  await forgetLink(database);

  expect(await readItems(database)).toEqual([
    { number: 1, link_id: "link", kind: "publication", state: "sent", payload: redacted },
    {
      number: 2,
      link_id: "link",
      kind: "retract",
      state: "queued",
      payload: '{"target":"item-1"}',
    },
    {
      number: 6,
      link_id: "link",
      kind: "retract",
      state: "sending",
      payload: '{"target":"item-7"}',
    },
    { number: 7, link_id: "link", kind: "reply", state: "sent", payload: redacted },
  ]);
});

test("a post that landed where it wasn't meant to stays, with one more withdrawal unless one is pending", async () => {
  const database = await openTestDatabase();
  const stray = { state: "stray", slack_ts: "1700000100.000100" };
  await storeSaying(database, 1, said, stray);
  await storeSaying(
    database,
    2,
    { target: "item-1" },
    {
      kind: "retract",
      request_id: 1,
      state: "failed",
      error: "cant_delete_message",
    },
  );
  await storeSaying(database, 3, said, stray);
  await storeSaying(database, 4, { target: "item-3" }, { kind: "retract", request_id: 3 });

  await forgetLink(database);

  expect(await readItems(database)).toEqual([
    { number: 1, link_id: "link", kind: "reply", state: "stray", payload: redacted },
    { number: 3, link_id: "link", kind: "reply", state: "stray", payload: redacted },
    {
      number: 4,
      link_id: "link",
      kind: "retract",
      state: "queued",
      payload: '{"target":"item-3"}',
    },
    {
      number: 5,
      link_id: "link",
      kind: "retract",
      state: "queued",
      payload: '{"target":"item-1"}',
    },
  ]);
  const [withdrawal] = await database.read(
    (sql) => sql`SELECT request_id, channel_id, thread_ts, created_at FROM outbox WHERE number = 5`,
  );
  expect(withdrawal).toEqual({
    request_id: 1,
    channel_id: "C-link",
    thread_ts: "1700000100.000100",
    created_at: 60_000,
  });
});

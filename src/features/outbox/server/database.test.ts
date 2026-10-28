import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import {
  cancelQueuedRequestItems,
  moveOutboxChannel,
  queueCard,
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
  approval_id: string | null;
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
      SELECT number, link_id, approval_id, kind, phase, channel_id, payload, payload_hash, state,
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
    approval_id: null,
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

test("a card update supersedes the approval's queued updates, but not its post or others' updates", async () => {
  const database = await openTestDatabase();
  const card = { approvalId: "approval", linkId: "link", channelId: "C-link" };
  await database.write(async (transaction) => {
    await queueCard(transaction, { ...card, phase: "post" }, 1_000);
    await queueCard(transaction, { ...card, phase: "update" }, 2_000);
    await queueCard(transaction, { ...card, approvalId: "other", phase: "update" }, 3_000);
  });

  await database.write((transaction) =>
    queueCard(transaction, { ...card, phase: "update" }, 4_000),
  );

  expect(
    (await readQueued(database)).map(({ number, approval_id, phase, state, updated_at }) => ({
      number,
      approval_id,
      phase,
      state,
      updated_at,
    })),
  ).toEqual([
    { number: 1, approval_id: "approval", phase: "post", state: "queued", updated_at: 1_000 },
    { number: 2, approval_id: "approval", phase: "update", state: "superseded", updated_at: 4_000 },
    { number: 3, approval_id: "other", phase: "update", state: "queued", updated_at: 3_000 },
    { number: 4, approval_id: "approval", phase: "update", state: "queued", updated_at: 4_000 },
  ]);
  expect((await readQueued(database))[0]).toMatchObject({
    link_id: "link",
    kind: "card",
    channel_id: "C-link",
    payload: "{}",
  });
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
    approval_id: null,
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

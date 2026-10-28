import { expect, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import type { Request } from "@requests/model/lifecycle";
import { askMessage, editMessage } from "@slackapi/model/testFixtures";
import { assignRequestMessage, hashInput, readRequest } from "./database";
import { cancelLinkRequests, releaseHolds, reviseStoredRequest } from "./lifecycle";
import { createStoredRequest } from "./testFixtures";

const ask = askMessage();

/** A request of the link's in each state, in its own thread. */
const everyState: Partial<Request>[] = [
  { state: "open" },
  { state: "seen", seenAt: 1 },
  { state: "in_progress", seenAt: 1 },
  { state: "answering", seenAt: 1 },
  { state: "answered", seenAt: 1 },
  { state: "dismissed", seenAt: 1, closedReason: "duplicate" },
  { state: "cancelled", closedReason: "source_deleted" },
  { state: "expired" },
];

function readClosings(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, state, closed_reason FROM requests ORDER BY id`);
}

function readHolds(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, held_at, hold_reason FROM requests ORDER BY id`);
}

test("revising a stored request saves it only when its messages changed", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const { contentHash } = await createStoredMessage(database, ask);
  const request = await createStoredRequest(database, {
    inputHash: hashInput([{ ts: ask.ts, deleted: false, contentHash }]),
  });
  await database.write((transaction) =>
    assignRequestMessage(transaction, request.id, "C-link", ask.ts),
  );
  const revise = () =>
    database.write((transaction) => reviseStoredRequest(transaction, request, 60_000));

  expect(await revise()).toBe(false);
  expect(await database.read((sql) => readRequest(sql, request.id))).toEqual(request);

  await createStoredMessage(database, editMessage(ask, "1700000150.000100", "<@U-bot> and prod?"));
  expect(await revise()).toBe(true);
  expect(await database.read((sql) => readRequest(sql, request.id))).toMatchObject({
    inputRev: 2,
    changedAt: 60_000,
  });
});

test("cancelling a link's requests closes its active ones with their queued replies", async () => {
  const database = await openTestDatabase();
  for (const [index, changes] of everyState.entries()) {
    const ts = `${1_700_000_100 + index}.000100`;
    await createStoredRequest(database, { rootTs: ts, sourceTs: ts, ...changes });
  }
  await createStoredRequest(database, { linkId: "other" });
  for (let id = 1; id <= everyState.length + 1; id++) {
    await createStoredOutboxItem(database, id, { request_id: id });
  }
  const cancel = () =>
    database.write((transaction) =>
      cancelLinkRequests(transaction, "link", "link_removed", 60_000),
    );

  expect(await cancel()).toBe(true);
  expect(await readClosings(database)).toEqual([
    { id: 1, state: "cancelled", closed_reason: "link_removed" },
    { id: 2, state: "cancelled", closed_reason: "link_removed" },
    { id: 3, state: "cancelled", closed_reason: "link_removed" },
    { id: 4, state: "cancelled", closed_reason: "link_removed" },
    { id: 5, state: "answered", closed_reason: null },
    { id: 6, state: "dismissed", closed_reason: "duplicate" },
    { id: 7, state: "cancelled", closed_reason: "source_deleted" },
    { id: 8, state: "expired", closed_reason: null },
    { id: 9, state: "open", closed_reason: null },
  ]);
  expect(
    await database.read((sql) => sql`SELECT number, state FROM outbox ORDER BY number`),
  ).toEqual([
    { number: 1, state: "cancelled" },
    { number: 2, state: "cancelled" },
    { number: 3, state: "cancelled" },
    { number: 4, state: "cancelled" },
    { number: 5, state: "queued" },
    { number: 6, state: "queued" },
    { number: 7, state: "queued" },
    { number: 8, state: "queued" },
    { number: 9, state: "queued" },
  ]);
  expect(await cancel()).toBe(false);
});

test("releasing holds frees the link's requests held before the owner spoke", async () => {
  const database = await openTestDatabase();
  const held = { state: "seen", seenAt: 1, holdReason: "asked the owner" } as const;
  await createStoredRequest(database, { ...held, heldAt: 1_000 });
  await createStoredRequest(database, { ...held, heldAt: 2_000, requesterUserId: "U-allowed" });
  await createStoredRequest(database, { state: "in_progress", seenAt: 1, requesterUserId: "U-x" });
  await createStoredRequest(database, { ...held, heldAt: 1_000, linkId: "other" });
  const release = () => database.write((transaction) => releaseHolds(transaction, "link", 2_000));

  expect(await release()).toBe(true);
  expect(await readHolds(database)).toEqual([
    { id: 1, held_at: null, hold_reason: null },
    { id: 2, held_at: 2_000, hold_reason: "asked the owner" },
    { id: 3, held_at: null, hold_reason: null },
    { id: 4, held_at: 1_000, hold_reason: "asked the owner" },
  ]);
  expect(await release()).toBe(false);
});

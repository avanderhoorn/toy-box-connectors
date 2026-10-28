import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { cancelQueuedRequestItems } from "./database";
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

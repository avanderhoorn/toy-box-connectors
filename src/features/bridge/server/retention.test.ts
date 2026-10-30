import { expect, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import { createStoredMessage } from "@activity/server/testFixtures";
import { countRows, createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { assignRequestMessage } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage } from "@slackapi/model/testFixtures";
import { applyRetention } from "./retention";
import { openTestDatabase } from "./testFixtures";

test("one pass forgets a month-old question with its request and reply, and who no link allows", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const ask = askMessage();
  await createStoredMessage(database, ask);
  const request = await createStoredRequest(database, { state: "answered" });
  await createStoredOutboxItem(database, 1, { state: "sent" });
  await createStoredOutboxItem(database, 2, {
    kind: "publication",
    request_id: null,
    thread_ts: null,
    series: "release-notes",
    scheduled_at: 0,
    state: "sent",
  });
  await database.write(async (transaction) => {
    await assignRequestMessage(transaction, request.id, ask.channelId, ask.ts);
    await transaction`INSERT INTO users (user_id, real_name) VALUES ('U-carol', 'Carol Chen')`;
  });

  const now = 1_700_000_200_000 + RETENTION_MS;
  await database.write((transaction) => applyRetention(transaction, now));

  expect(await countRows(database)).toMatchObject({
    messages: 0,
    changes: 0,
    requests: 0,
    request_messages: 0,
    users: 0,
  });
  // The publication's row keeps its slot reserved.
  expect(await database.read((sql) => sql`SELECT number, payload FROM outbox`)).toEqual([
    { number: 2, payload: null },
  ]);
});

test("a month-old post goes on its own, unless Slack never confirmed it or an item is still in its thread", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  // r1 is still being answered, so a post in its thread can't go with it.
  await createStoredRequest(database, { state: "answering" });
  const now = 1_700_000_200_000 + RETENTION_MS;
  const top = { kind: "post", request_id: null, thread_ts: null, state: "sent" };
  const under = (ts: string) => ({ ...top, thread_ts: ts });
  await createStoredOutboxItem(database, 1, { ...top, slack_ts: "1700000150.000100" });
  await createStoredOutboxItem(database, 2, {
    ...under("1700000150.000100"),
    state: "delivery_unknown",
  });
  await createStoredOutboxItem(database, 3, { ...under("1700000150.000100"), state: "retracted" });
  await createStoredOutboxItem(database, 4, { ...top, slack_ts: "1700000160.000100" });
  await createStoredOutboxItem(database, 5, {
    ...under("1700000160.000100"),
    updated_at: now - 86_400_000,
  });
  await createStoredOutboxItem(database, 6, { ...top, slack_ts: "1700000170.000100" });
  await createStoredOutboxItem(database, 7, { kind: "post", state: "failed" });

  await database.write((transaction) => applyRetention(transaction, now));

  expect(await database.read((sql) => sql`SELECT number FROM outbox ORDER BY number`)).toEqual([
    { number: 1 },
    { number: 2 },
    { number: 4 },
    { number: 5 },
  ]);
});

test.each(["queued", "sending", "delivery_unknown"])(
  "a finished request stays while a post in its thread is %s",
  async (state) => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredRequest(database, { state: "answered" });
    await createStoredRequest(database, {
      state: "answered",
      rootTs: "1700000150.000100",
      sourceTs: "1700000150.000100",
    });
    await createStoredOutboxItem(database, 1, { kind: "post", state });
    // A post at the top of the channel is in no request's thread, so r2 still goes.
    const top = { kind: "post", request_id: null, thread_ts: null, state };
    await createStoredOutboxItem(database, 2, top);

    const now = 1_700_000_200_000 + RETENTION_MS;
    await database.write((transaction) => applyRetention(transaction, now));

    expect(await database.read((sql) => sql`SELECT id FROM requests`)).toEqual([{ id: 1 }]);
    expect(await database.read((sql) => sql`SELECT number FROM outbox ORDER BY number`)).toEqual([
      { number: 1 },
      { number: 2 },
    ]);
  },
);

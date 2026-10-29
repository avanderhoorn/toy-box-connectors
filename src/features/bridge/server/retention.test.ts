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

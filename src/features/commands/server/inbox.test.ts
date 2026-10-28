import { expect, mock, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { dismissRequest, serveRequest } from "@requests/model/lifecycle";
import { saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage } from "@slackapi/model/testFixtures";
import { inboxCommand } from "./inbox";

const LEAD = { role: "lead", channelId: "toybox-link" } as const;

/** The request asked at the root of a thread of its own. */
function askedAt(thread: number) {
  return { rootTs: `1700000100.00010${thread}`, sourceTs: `1700000100.00010${thread}` };
}

test("shows changed requests first, up to its limit, and marks only those it showed read", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const read = await createStoredRequest(database, askedAt(1));
  await createStoredRequest(database, { ...askedAt(2), changedAt: 30 });
  const updated = await createStoredRequest(database, askedAt(3));
  const dismissed = await createStoredRequest(database, askedAt(4));
  await createStoredRequest(database, { ...askedAt(5), linkId: "other", channelId: "C-other" });
  await database.write(async (transaction) => {
    await saveRequest(transaction, serveRequest(read, 5));
    await saveRequest(transaction, {
      ...serveRequest(updated, 5),
      attention: "updated",
      changedAt: 20,
    });
    await saveRequest(transaction, dismissRequest(serveRequest(dismissed, 5), "Done"));
  });
  const wakes = { reconsider: mock(() => {}) };
  const inbox = inboxCommand({ database, wakes, workspaceUrl: () => null });

  const first = await inbox({ limit: 1 }, { caller: LEAD, at: 1_000 });
  const second = await inbox({ limit: 10 }, { caller: LEAD, at: 2_000 });

  expect(first.result).toMatchObject({ requests: [{ id: 3 }], more: 2 });
  // The open request stayed unread until an inbox showed it.
  expect(second.result).toMatchObject({ requests: [{ id: 2 }, { id: 1 }, { id: 3 }], more: 0 });
  const stored = await database.read(
    (sql) => sql`SELECT id, state, attention, touched_at AS touchedAt FROM requests ORDER BY id`,
  );
  expect([...stored]).toEqual([
    { id: 1, state: "seen", attention: null, touchedAt: 5 },
    { id: 2, state: "seen", attention: null, touchedAt: 2_000 },
    { id: 3, state: "seen", attention: null, touchedAt: 1_000 },
    { id: 4, state: "dismissed", attention: null, touchedAt: 5 },
    { id: 5, state: "open", attention: null, touchedAt: null },
  ]);
  expect(wakes.reconsider).toHaveBeenCalledTimes(2);
});

test("names the people a message mentions by the names the bridge stored", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database);
  await createStoredMessage(database, askMessage());
  await database.write((tx) => tx`INSERT INTO users (user_id, real_name) VALUES ('U-bot', 'Toy')`);
  const inbox = inboxCommand({ database, wakes: { reconsider() {} }, workspaceUrl: () => null });

  expect((await inbox({ limit: 10 }, { caller: LEAD, at: 1_000 })).result).toMatchObject({
    requests: [{ messages: [{ text: "{Toy} can you look at the deploy?" }] }],
  });
});

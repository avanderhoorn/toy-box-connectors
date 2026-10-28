import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { requestLifetimeMs, type Request } from "@requests/model/lifecycle";
import { cancelLinkRequests, expireRequests } from "./lifecycle";
import { createStoredRequest } from "./testFixtures";

/** Stores a request in each state, then an open one on another link, each with a queued reply. */
async function openEveryState(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const states: Partial<Request>[] = [
    { state: "open" },
    { state: "seen" },
    { state: "answering" },
    { state: "answered" },
    { state: "dismissed", closedReason: "duplicate" },
    { state: "cancelled", closedReason: "source_deleted" },
    { state: "expired" },
    { linkId: "other" },
  ];
  for (const [index, changes] of states.entries()) {
    const ts = `${1_700_000_100 + index}.000100`;
    const { id, linkId } = await createStoredRequest(database, {
      rootTs: ts,
      sourceTs: ts,
      ...changes,
    });
    await createStoredOutboxItem(database, id, { request_id: id, link_id: linkId });
  }
  return database;
}

function readRequests(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`
      SELECT requests.state, closed_reason AS closedReason, outbox.state AS reply
      FROM requests JOIN outbox ON outbox.request_id = requests.id ORDER BY requests.id
    `,
  );
}

test("cancelling a link's requests closes its active ones along with their queued replies", async () => {
  const database = await openEveryState();
  const cancel = () =>
    database.write((transaction) =>
      cancelLinkRequests(transaction, "link", "link_removed", 60_000),
    );
  expect(await cancel()).toBe(true);
  expect(await readRequests(database)).toEqual([
    { state: "cancelled", closedReason: "link_removed", reply: "cancelled" },
    { state: "cancelled", closedReason: "link_removed", reply: "cancelled" },
    { state: "cancelled", closedReason: "link_removed", reply: "cancelled" },
    { state: "answered", closedReason: null, reply: "queued" },
    { state: "dismissed", closedReason: "duplicate", reply: "queued" },
    { state: "cancelled", closedReason: "source_deleted", reply: "queued" },
    { state: "expired", closedReason: null, reply: "queued" },
    { state: "open", closedReason: null, reply: "queued" },
  ]);
  expect(await cancel()).toBe(false);
});

test("requests that waited their lifetime on the lead expire, but not one whose reply is in flight", async () => {
  const database = await openEveryState();
  const expire = (now: number) => database.write((transaction) => expireRequests(transaction, now));
  expect(await expire(requestLifetimeMs - 1)).toBe(false);
  expect(await expire(requestLifetimeMs)).toBe(true);
  expect((await readRequests(database)).map((request: { state: string }) => request.state)).toEqual(
    ["expired", "expired", "answering", "answered", "dismissed", "cancelled", "expired", "expired"],
  );
  expect(await expire(requestLifetimeMs)).toBe(false);
});

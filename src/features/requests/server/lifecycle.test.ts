import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { requestLifetimeMs, requestStates } from "@requests/model/lifecycle";
import { readActiveRequests } from "./database";
import { expireRequests } from "./lifecycle";
import { createStoredRequest } from "./testFixtures";

test("requests that waited their lifetime on the lead expire, but not one whose reply is in flight", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  for (const state of requestStates) {
    const closedReason = state === "dismissed" || state === "cancelled" ? "closed" : null;
    await createStoredRequest(database, { state, closedReason });
  }
  const expire = (now: number) => database.write((transaction) => expireRequests(transaction, now));
  const active = async () =>
    (await database.read((sql) => readActiveRequests(sql, "link"))).map((request) => request.state);
  expect(await active()).toEqual(["open", "seen", "answering"]);
  expect(await expire(requestLifetimeMs - 1)).toBe(false);
  expect(await expire(requestLifetimeMs)).toBe(true);
  expect(await active()).toEqual(["answering"]);
  expect(await expire(requestLifetimeMs)).toBe(false);
});

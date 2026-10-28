import { expect, onTestFinished, spyOn, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { startWakeScheduler } from ".";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

test("wakes a lead once its requests settle and logs the run at its start", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database, { changedAt: NOW - 10_000, expiresAt: NOW + 60_000 });
  const { promise: woken, resolve } = Promise.withResolvers<string>();
  let clock = NOW;
  const wakeLead = async (channelId: string) => {
    clock += 5_000;
    resolve(channelId);
    return "ran" as const;
  };
  const scheduler = startWakeScheduler(database, wakeLead, { now: () => clock });

  expect(await woken).toBe("toybox-link");
  await scheduler.stop();
  // The run left the request unread, so the next pass waited instead of waking again.
  expect(await database.read((sql) => sql`SELECT link_id, at, outcome FROM wakes`)).toEqual([
    { link_id: "link", at: NOW, outcome: "ran" },
  ]);
});

test("stops and reports a storage error instead of deciding again", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  const database = await openTestDatabase();
  await database.write((transaction) => transaction`DROP TABLE wakes`);
  const { promise: failed, resolve } = Promise.withResolvers<unknown>();
  const options = { onError: resolve, now: () => NOW };
  const scheduler = startWakeScheduler(database, async () => "ran", options);

  expect(String(await failed)).toContain("no such table: wakes");
  await scheduler.stop();
});

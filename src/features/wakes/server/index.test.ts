import { expect, onTestFinished, spyOn, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { startWakeScheduler } from ".";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

test("wakes a lead once its requests settle, and stopping mid-run logs it and leaves no timer", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database, { createdAt: NOW - 10_000, changedAt: NOW - 10_000 });
  const { promise: woken, resolve } = Promise.withResolvers<string>();
  let clock = NOW;
  const wakeLead = async (channelId: string) => {
    clock += 5_000;
    resolve(channelId);
    return "ran" as const;
  };
  const timers = spyOn(globalThis, "setTimeout");
  onTestFinished(() => timers.mockRestore());
  const scheduler = startWakeScheduler(database, wakeLead, { now: () => clock });

  expect(await woken).toBe("toybox-link");
  await scheduler.stop();
  // The run is logged at its start, and no timer is left to keep the bridge from exiting.
  expect(await database.read((sql) => sql`SELECT link_id, at, outcome FROM wakes`)).toEqual([
    { link_id: "link", at: NOW, outcome: "ran" },
  ]);
  expect(timers.mock.results.filter(({ value }) => (value as Timer).hasRef())).toEqual([]);
});

import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { RoutineRunOutcome } from "@toybox/model";
import { retryDelay } from "@wakes/model";
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

test("marks the requests no lead has read with 👀 once Toy Box runs their wake, and not before", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const settled = { createdAt: NOW - 10_000, changedAt: NOW - 10_000 };
  await createStoredRequest(database, settled);
  await createStoredRequest(database, {
    ...settled,
    sourceTs: "1700000200.000200",
    state: "seen",
    attention: "updated",
    touchedAt: NOW - 20_000,
  });
  const outcomes: RoutineRunOutcome[] = ["failed", "ran"];
  const failed = Promise.withResolvers<unknown>();
  const acknowledged = Promise.withResolvers<unknown>();
  const acknowledge = mock(acknowledged.resolve);
  let clock = NOW;
  const scheduler = startWakeScheduler(database, async () => outcomes.shift()!, {
    acknowledge,
    now: () => clock,
    log: failed.resolve,
  });

  await failed.promise;
  expect(acknowledge).not.toHaveBeenCalled();
  clock += retryDelay(1);
  scheduler.reconsider();
  // The request the lead read and that changed since already has 👀.
  expect(await acknowledged.promise).toEqual([
    expect.objectContaining({ channelId: "C-link", sourceTs: "1700000100.000100" }),
  ]);
  await scheduler.stop();
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

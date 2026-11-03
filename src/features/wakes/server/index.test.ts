import { expect, onTestFinished, spyOn, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readOwedDisplays } from "@outbox/server/testFixtures";
import { requestLifetimeMs, serveRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
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

test("owes 👀 to the requests no lead has read once Toy Box runs their wake, and not before", async () => {
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
  const ran = Promise.withResolvers<void>();
  let clock = NOW;
  const scheduler = startWakeScheduler(
    database,
    async () => {
      const outcome = outcomes.shift()!;
      if (outcome === "ran") ran.resolve();
      return outcome;
    },
    { now: () => clock, log: failed.resolve },
  );

  await failed.promise;
  expect(await readOwedDisplays(database)).toEqual([]);
  clock += retryDelay(1);
  scheduler.reconsider();
  await ran.promise;
  // Stopping waits for the pass, which owes 👀 as it records the run.
  await scheduler.stop();
  // The request the lead read and that changed since already has 🏃.
  expect(await readOwedDisplays(database)).toMatchObject([
    { channelId: "C-link", sourceTs: "1700000100.000100", shows: "eyes" },
  ]);
});

test("doesn't owe 👀 to a request the lead read while Toy Box ran its wake", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const asked = await createStoredRequest(database, {
    createdAt: NOW - 10_000,
    changedAt: NOW - 10_000,
  });
  const running = Promise.withResolvers<void>();
  const wakeLead = async () => {
    running.resolve();
    await database.write(async (transaction) => {
      await saveRequest(
        transaction,
        serveRequest((await readRequest(transaction, asked.id))!, NOW),
        NOW,
      );
    });
    return "ran" as const;
  };
  const scheduler = startWakeScheduler(database, wakeLead, { now: () => NOW });

  await running.promise;
  // Stopping waits for the pass, so what it owes would be in by now.
  await scheduler.stop();
  expect(await readOwedDisplays(database)).toMatchObject([{ shows: "runner" }]);
});

test("owes 👀 back to the requests the lead read that expired unanswered, and not the ones it never read", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const stale = { createdAt: 0, changedAt: 0, touchedAt: 0 };
  await createStoredRequest(database, { ...stale, state: "seen" });
  await createStoredRequest(database, { ...stale, sourceTs: "1700000200.000200" });
  const scheduler = startWakeScheduler(database, async () => "failed", {
    now: () => requestLifetimeMs,
    log: () => {},
  });

  await scheduler.stop();
  expect(await readOwedDisplays(database)).toMatchObject([
    { sourceTs: "1700000100.000100", shows: "eyes" },
  ]);
});

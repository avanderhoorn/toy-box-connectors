import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { pruneWakes, readLinkWakes, recordWake } from "./database";

const HOUR = 60 * 60_000;

test("a link's wake state is its open and seen requests and its runs, newest first", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "paused", { status: "paused" });
  await createStoredRequest(database, { rootTs: "1.1", sourceTs: "1.1", changedAt: 5 });
  await createStoredRequest(database, {
    rootTs: "1.2",
    sourceTs: "1.2",
    state: "seen",
    attention: "updated",
    changedAt: 7,
    touchedAt: 6,
  });
  await createStoredRequest(database, { rootTs: "1.3", state: "expired" });
  await database.write(async (transaction) => {
    await recordWake(transaction, "link", 10, "failed");
    await recordWake(transaction, "link", 20, "ran");
    // A link removed while its run was in flight isn't recorded.
    await recordWake(transaction, "gone", 30, "ran");
  });

  expect(await database.read(readLinkWakes)).toEqual([
    {
      id: "link",
      channelId: "toybox-link",
      active: true,
      suspendedAt: null,
      requests: [
        {
          channelId: "C-link",
          sourceTs: "1.1",
          state: "open",
          attention: null,
          changedAt: 5,
          touchedAt: null,
        },
        {
          channelId: "C-link",
          sourceTs: "1.2",
          state: "seen",
          attention: "updated",
          changedAt: 7,
          touchedAt: 6,
        },
      ],
      runs: [
        { at: 20, outcome: "ran" },
        { at: 10, outcome: "failed" },
      ],
    },
    {
      id: "paused",
      channelId: "toybox-paused",
      active: false,
      suspendedAt: null,
      requests: [],
      runs: [],
    },
  ]);
});

test("pruning keeps the past hour, a link's latest run and its latest runs that landed", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const now = 10 * HOUR;
  const prune = async (at: number) => {
    await database.write(async (transaction) => {
      await recordWake(transaction, "link", at, "refused");
      await pruneWakes(transaction, now);
    });
    const [link] = await database.read(readLinkWakes);
    return link!.runs.map(({ at }) => at);
  };
  await database.write(async (transaction) => {
    for (const at of [1, 2, 3, 4, 5]) await recordWake(transaction, "link", at, "ran");
    await recordWake(transaction, "link", 6, "failed");
  });

  expect(await prune(7)).toEqual([7, 5, 4, 3, 2]);
  expect(await prune(now - HOUR + 1)).toEqual([now - HOUR + 1, 5, 4, 3, 2]);
});

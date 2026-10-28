import { expect, test } from "bun:test";
import { interruptionGap } from "@activity/model/gaps";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { tsAt } from "@slackapi/model/ts";
import { recordInterruption } from "./coverage";

const NOW = Date.parse("2026-10-28T09:00:00Z");

function readGaps(database: BridgeDatabase) {
  return database.read(
    (sql) =>
      sql`SELECT link_id, channel_id, thread_ts, oldest_ts, latest_ts, state, reason, opened_at
          FROM coverage ORDER BY id`,
  );
}

function linkAt(database: BridgeDatabase, linkId: string, linkedAtTs: string) {
  return database.write(
    (transaction) =>
      transaction`UPDATE links SET linked_at_ts = ${linkedAtTs} WHERE id = ${linkId}`,
  );
}

test("an interruption opens a gap in every linked channel, whatever its link's status", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "watch");
  await createStoredLink(database, "paused", { status: "paused" });
  const since = NOW - 3_600_000;

  await database.write((transaction) =>
    recordInterruption(transaction, "auth_failed", since, NOW - 60_000, NOW),
  );
  const window = interruptionGap(since, NOW - 60_000, "1700000000.000100")!;
  expect(await readGaps(database)).toEqual(
    ["paused", "watch"].map((id) => ({
      link_id: id,
      channel_id: `C-${id}`,
      thread_ts: null,
      oldest_ts: window.oldestTs,
      latest_ts: window.latestTs,
      state: "open",
      reason: "auth_failed",
      opened_at: NOW,
    })),
  );
});

test("an interruption doesn't reach back before its link began", async () => {
  const database = await openTestDatabase();
  for (const id of ["early", "within", "later"]) await createStoredLink(database, id);
  await linkAt(database, "within", tsAt(NOW - 60_000));
  await linkAt(database, "later", tsAt(NOW + 3_600_000));

  await database.write((transaction) =>
    recordInterruption(transaction, "disconnect", NOW - 3_600_000, NOW, NOW),
  );
  const gaps = await readGaps(database);
  expect(gaps.map((gap: { link_id: string }) => gap.link_id)).toEqual(["early", "within"]);
  expect(gaps[1].oldest_ts).toBe(tsAt(NOW - 60_000));
});

import { describe, expect, test } from "bun:test";
import { interruptionGap } from "@activity/model/gaps";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import type { Request } from "@requests/model/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import { tsAt } from "@slackapi/model/ts";
import { recordReceipt } from "@slackapi/server/receipts";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import {
  recordChannelGaps,
  recordConnect,
  recordDisconnect,
  recordGap,
  recordInterruption,
} from "./coverage";

const NOW = Date.parse("2026-10-28T09:00:00Z");

function readGaps(database: BridgeDatabase) {
  return database.read(
    (sql) =>
      sql`SELECT link_id, channel_id, thread_ts, oldest_ts, latest_ts, state, reason, opened_at
          FROM coverage ORDER BY id`,
  );
}

function readHolds(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT link_id, state, source_unverified_at FROM requests ORDER BY id`,
  );
}

function readMarkers(database: BridgeDatabase) {
  return database.read(async (sql) => {
    const [row] = await sql`SELECT connected_at, disconnected_at FROM installation`;
    return row;
  });
}

/** A request U-owner opened in `linkId`'s channel at the root posted at `rootTs`. */
function createRequestIn(linkId: string, rootTs: string, changes: Partial<Request> = {}) {
  return { linkId, channelId: `C-${linkId}`, rootTs, sourceTs: rootTs, ...changes };
}

/**
 * Stores, in link `watch`, an open request, a seen one held since 500 and an expired one, and an
 * open request in link `other`.
 */
async function createRequests(database: BridgeDatabase) {
  await createStoredRequest(database, createRequestIn("watch", "1700000100.000100"));
  await createStoredRequest(
    database,
    createRequestIn("watch", "1700000200.000100", {
      state: "seen",
      seenAt: 1,
      sourceUnverifiedAt: 500,
    }),
  );
  await createStoredRequest(
    database,
    createRequestIn("watch", "1700000300.000100", { state: "expired" }),
  );
  await createStoredRequest(database, createRequestIn("other", "1700000100.000100"));
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

test("a link that began after an interruption holds none of its requests", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "later");
  await linkAt(database, "later", tsAt(NOW + 3_600_000));
  await createStoredRequest(database, createRequestIn("later", "1700000100.000100"));

  await database.write((transaction) =>
    recordInterruption(transaction, "disconnect", NOW - 3_600_000, NOW, NOW),
  );
  expect(await readHolds(database)).toEqual([
    { link_id: "later", state: "open", source_unverified_at: null },
  ]);
});

describe("holding pending replies", () => {
  test("a channel gap holds its link's pending requests, and a held one keeps its first hold", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "watch");
    await createStoredLink(database, "other");
    await createRequests(database);

    await database.write((transaction) =>
      recordChannelGaps(transaction, "C-watch", "malformed", NOW, (linkedAtTs) =>
        interruptionGap(NOW - 60_000, NOW, linkedAtTs),
      ),
    );
    expect(await readHolds(database)).toEqual([
      { link_id: "watch", state: "open", source_unverified_at: NOW },
      { link_id: "watch", state: "seen", source_unverified_at: 500 },
      { link_id: "watch", state: "expired", source_unverified_at: null },
      { link_id: "other", state: "open", source_unverified_at: null },
    ]);
  });

  test("a thread's gap holds nothing, since only the thread is read again", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database, "watch");
    await createStoredRequest(database, createRequestIn("watch", "1700000100.000100"));

    const window = interruptionGap(NOW - 60_000, NOW, "1700000000.000100")!;
    const thread = { linkId: "watch", channelId: "C-watch", threadTs: "1700000100.000100" };
    await database.write((transaction) =>
      recordGap(transaction, { ...thread, window, reason: "thread" }, NOW),
    );
    expect(await readHolds(database)).toEqual([
      { link_id: "watch", state: "open", source_unverified_at: null },
    ]);
  });

  test("a lost connection holds every pending request, whatever its link's status, and notes when", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await createStoredLink(database, "watch");
    await createStoredLink(database, "other", { status: "paused" });
    await createRequests(database);

    await database.write((transaction) => recordDisconnect(transaction, NOW));
    expect(await readHolds(database)).toEqual([
      { link_id: "watch", state: "open", source_unverified_at: NOW },
      { link_id: "watch", state: "seen", source_unverified_at: 500 },
      { link_id: "watch", state: "expired", source_unverified_at: null },
      { link_id: "other", state: "open", source_unverified_at: NOW },
    ]);
    expect(await readMarkers(database)).toEqual({ connected_at: null, disconnected_at: NOW });
    expect(await readGaps(database)).toEqual([]);
  });
});

describe("a hello", () => {
  const helloAt = NOW - 60_000;

  function receivedAt(database: BridgeDatabase, key: string, at: number) {
    const receipt = { key, type: "message", receivedAt: at, disposition: "applied" } as const;
    return database.write((transaction) => recordReceipt(transaction, receipt));
  }

  function connectedAt(database: BridgeDatabase, at: number) {
    return database.write(
      (transaction) => transaction`UPDATE installation SET connected_at = ${at}`,
    );
  }

  async function readSpans(database: BridgeDatabase) {
    const gaps = await readGaps(database);
    return gaps.map((gap: { oldest_ts: string; latest_ts: string; reason: string }) => ({
      oldest_ts: gap.oldest_ts,
      latest_ts: gap.latest_ts,
      reason: gap.reason,
    }));
  }

  test("after the bridge never received anything reaches back to when each link began", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    await createStoredLink(database, "watch");
    await createStoredRequest(database, createRequestIn("watch", "1700000100.000100"));

    await database.write((transaction) => recordConnect(transaction, helloAt, "startup", NOW));
    expect(await readSpans(database)).toEqual([
      {
        oldest_ts: "1700000000.000100",
        latest_ts: interruptionGap(0, helloAt, "1700000000.000100")!.latestTs,
        reason: "startup",
      },
    ]);
    expect(await readHolds(database)).toEqual([
      { link_id: "watch", state: "open", source_unverified_at: NOW },
    ]);
    expect(await readMarkers(database)).toEqual({ connected_at: helloAt, disconnected_at: null });
  });

  test("reaches back to the later of the last receipt and the hello before it", async () => {
    for (const [receipt, previous] of [
      [NOW - 600_000, NOW - 900_000],
      [NOW - 900_000, NOW - 600_000],
    ] as const) {
      const database = await openTestDatabase();
      await createStoredInstallation(database);
      await createStoredLink(database, "watch");
      await receivedAt(database, "Ev-early", receipt - 60_000);
      await receivedAt(database, "Ev-last", receipt);
      await connectedAt(database, previous);

      await database.write((transaction) => recordConnect(transaction, helloAt, "disconnect", NOW));
      const window = interruptionGap(NOW - 600_000, helloAt, "1700000000.000100")!;
      expect(await readSpans(database)).toEqual([
        { oldest_ts: window.oldestTs, latest_ts: window.latestTs, reason: "disconnect" },
      ]);
      expect(await readMarkers(database)).toEqual({
        connected_at: helloAt,
        disconnected_at: null,
      });
    }
  });
});

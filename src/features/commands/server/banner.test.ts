import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { Caller } from "@commands/model/callers";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { LeadPresence } from "@toybox/model/presence";
import { writeToyBoxStream } from "@toybox/server/database";
import { readBanner, readLinksInView, readUnsettledPosts } from "./banner";

const AT = Date.parse("2026-10-27T16:00:00Z");

function registerSeries(
  database: BridgeDatabase,
  linkId: string,
  series: string,
  columns: { routine_state?: string; period?: string } = {},
) {
  const row = {
    link_id: linkId,
    series,
    routine_id: `routine-${series}`,
    routine_state: "present",
    period: "day",
    schedule: "0 17 * * 1-5",
    registered_at: 0,
    ...columns,
  };
  return database.write(
    (transaction) => transaction`INSERT INTO link_routines ${transaction(row)}`,
  );
}

let gaps = 0;

function recordGap(database: BridgeDatabase, linkId: string, state: string) {
  gaps += 1;
  const row = {
    link_id: linkId,
    channel_id: `C-${linkId}`,
    scope: "channel",
    oldest_ts: `1700000000.00000${gaps}`,
    latest_ts: `1700000100.00000${gaps}`,
    state,
    reason: "disconnect",
    opened_at: 0,
  };
  return database.write((transaction) => transaction`INSERT INTO coverage ${transaction(row)}`);
}

function suspend(database: BridgeDatabase, linkId: string, reason: string) {
  return database.write(
    (transaction) => transaction`
      UPDATE links SET status = 'suspended', status_reason = ${reason} WHERE id = ${linkId}
    `,
  );
}

/** Two links: `link` for toybox-link and `other` for toybox-other. */
async function openTwoLinks() {
  const database = await openTestDatabase();
  await createStoredLink(database, "link");
  await createStoredLink(database, "other");
  return database;
}

describe("reading the links in view", () => {
  test("reads each link with its coverage and routines, the requests routine first", async () => {
    const database = await openTwoLinks();
    await registerSeries(database, "link", "release-notes", {
      routine_state: "drifted",
      period: "week",
    });
    await registerSeries(database, "link", "digest");
    await suspend(database, "other", "bot_removed");

    expect(await database.read((sql) => readLinksInView(sql, null))).toEqual([
      {
        id: "link",
        toyBoxChannelId: "toybox-link",
        slackChannelId: "C-link",
        status: "active",
        statusReason: null,
        coverage: "complete",
        routines: [
          { series: null, routineId: "routine-link", period: null, state: "present" },
          { series: "digest", routineId: "routine-digest", period: "day", state: "present" },
          {
            series: "release-notes",
            routineId: "routine-release-notes",
            period: "week",
            state: "drifted",
          },
        ],
      },
      {
        id: "other",
        toyBoxChannelId: "toybox-other",
        slackChannelId: "C-other",
        status: "suspended",
        statusReason: "bot_removed",
        coverage: "complete",
        routines: [{ series: null, routineId: "routine-other", period: null, state: "present" }],
      },
    ]);
  });

  test("only the channel's own link is in view for a channel", async () => {
    const database = await openTwoLinks();

    const ids = async (channelId: string | null) =>
      (await database.read((sql) => readLinksInView(sql, channelId))).map(({ id }) => id);
    expect(await ids("toybox-other")).toEqual(["other"]);
    expect(await ids("toybox-unlinked")).toEqual([]);
  });

  test("a gap open or under repair reads as repairing ahead of one a repair couldn't finish", async () => {
    const database = await openTwoLinks();
    await recordGap(database, "link", "repaired");
    await recordGap(database, "link", "partial");
    await recordGap(database, "other", "partial");
    await recordGap(database, "other", "open");

    const coverage = async (channelId: string) =>
      (await database.read((sql) => readLinksInView(sql, channelId)))[0]!.coverage;
    expect(await coverage("toybox-link")).toBe("partial");
    expect(await coverage("toybox-other")).toBe("repairing");
    await database.write((transaction) => transaction`DELETE FROM coverage WHERE state = 'open'`);
    await recordGap(database, "other", "repairing");
    expect(await coverage("toybox-other")).toBe("repairing");
  });
});

describe("reading unsettled posts", () => {
  test("a channel's are its link's and its requests'", async () => {
    const database = await openTwoLinks();
    const request = await createStoredRequest(database);
    const otherRequest = await createStoredRequest(database, {
      linkId: "other",
      rootTs: "1700000200.000100",
      sourceTs: "1700000200.000100",
    });
    await createStoredOutboxItem(database, 1, {
      request_id: request.id,
      state: "delivery_unknown",
    });
    await createStoredOutboxItem(database, 2, {
      link_id: null,
      request_id: request.id,
      phase: "follow_up",
      state: "stray",
    });
    await createStoredOutboxItem(database, 4, {
      link_id: "other",
      request_id: otherRequest.id,
      state: "delivery_unknown",
    });
    await createStoredOutboxItem(database, 5, {
      request_id: request.id,
      request_rev: 2,
      state: "sent",
    });

    expect(await database.read((sql) => readUnsettledPosts(sql, "toybox-link"))).toEqual([
      { item: "o1", kind: "reply", state: "delivery_unknown" },
      { item: "o2", kind: "reply", state: "stray" },
    ]);
    const all = await database.read((sql) => readUnsettledPosts(sql, null));
    expect(all.map(({ item }) => item)).toEqual(["o1", "o2", "o4"]);
  });
});

describe("reading the banner", () => {
  const lead: Caller = { role: "lead", channelId: "toybox-link", sessionId: "toybox-link" };

  function storeLead(database: BridgeDatabase, lead: LeadPresence) {
    return database.write((transaction) =>
      writeToyBoxStream(transaction, "toybox-link", {
        revision: 7,
        ownerSpokeAt: null,
        provider: "copilot",
        lead,
      }),
    );
  }

  test("a lead mid-turn gets back the waiting status its wake cleared, and nobody else does", async () => {
    const database = await openTwoLinks();
    await storeLead(database, {
      state: "working",
      restore: { text: "Alice's review", wakeAt: AT + 30 * 60_000 },
    });

    const banner = (caller: Caller) =>
      database.read((sql) => readBanner(sql, caller, { slack: "connected", at: AT }));
    expect(await banner(lead)).toEqual({
      slack: "connected",
      coverage: "complete",
      warnings: [],
      restore: { waitingFor: "Alice's review", wakeAfterMinutes: 30 },
    });
    expect(
      (await banner({ role: "member", channelId: "toybox-link", sessionId: "m" })).restore,
    ).toBeNull();
    expect(
      (await banner({ role: "operator", channelId: "toybox-link", sessionId: null })).restore,
    ).toBeNull();

    await storeLead(database, { state: "working", restore: null });
    expect((await banner(lead)).restore).toBeNull();
    await storeLead(database, { state: "waiting", waiting: { text: "Alice", wakeAt: null } });
    expect((await banner(lead)).restore).toBeNull();
  });

  test("the operator's banner covers every link, and a channel's only its own", async () => {
    const database = await openTwoLinks();
    await database.write((transaction) => transaction`UPDATE links SET status = 'paused'`);
    await suspend(database, "other", "toybox_channel_deleted");
    await recordGap(database, "other", "partial");

    const banner = (channelId: string | null) =>
      database.read((sql) =>
        readBanner(
          sql,
          { role: "operator", channelId, sessionId: null },
          { slack: "reconnecting", at: AT },
        ),
      );
    expect(await banner(null)).toEqual({
      slack: "reconnecting",
      coverage: "partial",
      warnings: [
        { kind: "link_inactive", status: "paused", reason: null },
        { kind: "link_inactive", status: "suspended", reason: "toybox_channel_deleted" },
      ],
      restore: null,
    });
    expect((await banner("toybox-link")).warnings).toEqual([
      { kind: "link_inactive", status: "paused", reason: null },
    ]);
    expect(await banner("toybox-unlinked")).toEqual({
      slack: "reconnecting",
      coverage: null,
      warnings: [],
      restore: null,
    });
  });
});

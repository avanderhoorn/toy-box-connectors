import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelCaller } from "@commands/model/callers";
import { createStoredLink } from "@links/server/testFixtures";
import { routineTemplates, type RoutineTemplateName } from "@toybox/model/routines";
import { routinesCommand } from "./routines";

const AT = 1_700_002_000_000;

const lead: ChannelCaller = { role: "lead", channelId: "toybox-link", sessionId: "lead-session" };

function registerSeries(
  database: BridgeDatabase,
  series: string,
  columns: { routine_state?: string; period?: string; schedule?: string } = {},
) {
  const row = {
    link_id: "link",
    series,
    routine_id: `routine-${series}`,
    routine_state: "present",
    period: "week",
    schedule: "0 16 * * 5",
    registered_at: 0,
    ...columns,
  };
  return database.write(
    (transaction) => transaction`INSERT INTO link_routines ${transaction(row)}`,
  );
}

function routines(database: BridgeDatabase, template?: RoutineTemplateName, caller = lead) {
  return routinesCommand({ database })({ template }, { caller, at: AT });
}

/** Each template as it is, with nothing registered for it. */
function unregistered(name: RoutineTemplateName) {
  return { template: name, ...routineTemplates[name], registered: null };
}

describe("showing routines", () => {
  test("before a link, every template has nothing registered", async () => {
    const database = await openTestDatabase();

    expect(await routines(database)).toEqual({
      linked: false,
      routines: [unregistered("requests"), unregistered("digest"), unregistered("release-notes")],
    });
  });

  test("a link's requests routine and release notes series come with their templates", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await registerSeries(database, "release-notes", {
      routine_state: "drifted",
      period: "day",
      schedule: "0 10 * * 1-5",
    });

    expect(await routines(database)).toEqual({
      linked: true,
      routines: [
        {
          ...unregistered("requests"),
          registered: { routineId: "routine-link", period: null, state: "present" },
        },
        unregistered("digest"),
        {
          ...unregistered("release-notes"),
          schedule: "0 10 * * 1-5",
          registered: { routineId: "routine-release-notes", period: "day", state: "drifted" },
        },
      ],
    });
  });

  test("another series isn't the release notes", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await registerSeries(database, "changelog");

    expect(await routines(database, "release-notes")).toEqual({
      linked: true,
      routines: [unregistered("release-notes")],
    });
  });

  test("shows only the template asked for", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await database.write((transaction) => transaction`UPDATE links SET routine_state = 'missing'`);

    expect(await routines(database, "requests")).toEqual({
      linked: true,
      routines: [
        {
          ...unregistered("requests"),
          registered: { routineId: "routine-link", period: null, state: "missing" },
        },
      ],
    });
    expect((await routines(database, "digest")).routines).toEqual([unregistered("digest")]);
  });

  test("reads only the caller's own channel's link", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredLink(database, "other");

    const operator: ChannelCaller = {
      role: "operator",
      channelId: "toybox-other",
      sessionId: null,
    };
    const shown = await routines(database, "requests", operator);
    expect(shown.routines[0]!.registered).toEqual({
      routineId: "routine-other",
      period: null,
      state: "present",
    });

    const member: ChannelCaller = { role: "member", channelId: "toybox-new", sessionId: "member" };
    expect(await routines(database, "requests", member)).toEqual({
      linked: false,
      routines: [unregistered("requests")],
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelCaller } from "@commands/model/callers";
import { createStoredLink } from "@links/server/testFixtures";
import type { Request, RequestState } from "@requests/model/lifecycle";
import { readRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { holdCommand } from "./hold";

const AT = 1_700_002_000_000;
const DAY = 24 * 60 * 60_000;

const lead: ChannelCaller = { role: "lead", channelId: "toybox-link", sessionId: "lead-session" };
const seen = { state: "seen", seenAt: 1, expiresAt: AT + 6 * DAY } as const;

async function openLinked(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
}

/** Hold for the tests' link, counting how often it asks the wake scheduler to decide again. */
function holdFor(database: BridgeDatabase) {
  let reconsidered = 0;
  const hold = holdCommand({ database, wakes: { reconsider: () => void reconsidered++ } });
  return {
    hold: (request: number, reason = "Asked the owner which date", at = AT, caller = lead) =>
      hold({ request, reason }, { caller, at }),
    reconsidered: () => reconsidered,
  };
}

function readStored(database: BridgeDatabase, id = 1) {
  return database.read((sql) => readRequest(sql, id));
}

describe("holding a request", () => {
  test("stops its reminders until the owner decides, then asks for a new wake decision", async () => {
    const database = await openLinked();
    const request = await createStoredRequest(database, seen);
    const { hold, reconsidered } = holdFor(database);

    expect(await hold(1)).toEqual({ request: 1, attention: null, expiresAt: AT + 6 * DAY });
    expect(await readStored(database)).toEqual({
      ...request,
      heldAt: AT,
      holdReason: "Asked the owner which date",
      touchedAt: AT,
    });
    expect(reconsidered()).toBe(1);
  });

  test("holding again replaces the reason and when it was held", async () => {
    const database = await openLinked();
    await createStoredRequest(database, { ...seen, state: "in_progress" });
    const { hold } = holdFor(database);

    await hold(1, "Asked the owner which date");
    await hold(1, "Asked the owner about the budget", AT + 60_000);
    expect(await readStored(database)).toMatchObject({
      state: "in_progress",
      heldAt: AT + 60_000,
      holdReason: "Asked the owner about the budget",
    });
  });

  test("says what a held request still needs from the lead", async () => {
    const database = await openLinked();
    await createStoredRequest(database, { ...seen, attention: "updated" });
    await createStoredRequest(database, {
      ...seen,
      rootTs: "1700000200.000100",
      sourceTs: "1700000200.000100",
      attention: "reply_failed",
    });
    const { hold } = holdFor(database);

    expect(await hold(1)).toMatchObject({ attention: "updated" });
    expect(await hold(2)).toMatchObject({ attention: "reply_failed" });
  });

  const unholdable: [RequestState, string, Partial<Request>][] = [
    ["open", "unread_request", {}],
    ["answering", "answering_request", { seenAt: 1 }],
    ["answered", "closed_request", { seenAt: 1 }],
    ["dismissed", "closed_request", { seenAt: 1, closedReason: "Duplicate" }],
    ["cancelled", "closed_request", { closedReason: "source_deleted" }],
    ["expired", "closed_request", {}],
  ];

  test.each(unholdable)(
    "refuses a request that's %s with %s, changing nothing",
    async (state, rule, changes) => {
      const database = await openLinked();
      const request = await createStoredRequest(database, { state, ...changes });
      const { hold, reconsidered } = holdFor(database);

      await expect(hold(1)).rejects.toMatchObject({ rule });
      expect(await readStored(database)).toEqual(request);
      expect(reconsidered()).toBe(0);
    },
  );

  test("refuses another link's request the same way as one that doesn't exist", async () => {
    const database = await openLinked();
    await createStoredLink(database, "other");
    await createStoredRequest(database, seen);
    await createStoredRequest(database, { ...seen, linkId: "other" });
    const { hold, reconsidered } = holdFor(database);
    const unknown = (id: number) => ({
      rule: "unknown_request",
      message: `This channel has no request r${id}. Run \`toy-box-slack inbox\` to see its requests.`,
    });

    await expect(hold(2)).rejects.toMatchObject(unknown(2));
    await expect(hold(3)).rejects.toMatchObject(unknown(3));
    expect(await readStored(database, 2)).toMatchObject({ heldAt: null });
    await expect(
      hold(1, "Asked the owner", AT, { ...lead, channelId: "toybox-unlinked" }),
    ).rejects.toMatchObject({
      rule: "not_linked",
      message: "This Toy Box channel isn't linked to Slack, so it has no r1.",
    });
    expect(await readStored(database)).toMatchObject({ heldAt: null });
    expect(reconsidered()).toBe(0);
  });
});

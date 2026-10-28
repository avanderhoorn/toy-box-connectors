import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelCaller } from "@commands/model/callers";
import { createStoredLink } from "@links/server/testFixtures";
import { readRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { dismissCommand } from "./dismiss";

const AT = 1_700_002_000_000;

const lead: ChannelCaller = { role: "lead", channelId: "toybox-link", sessionId: "lead-session" };
const revised = { state: "seen", seenAt: 1, inputRev: 2, servedRev: 2 } as const;

async function openLinked(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredLink(database);
  return database;
}

/** Dismiss for the tests' link, counting how often it asks the wake scheduler to decide again. */
function dismissFor(database: BridgeDatabase) {
  let reconsidered = 0;
  const dismiss = dismissCommand({ database, wakes: { reconsider: () => void reconsidered++ } });
  return {
    dismiss: (request: number, revision: number, caller = lead) =>
      dismiss({ request, revision, reason: "Duplicate of r12" }, { caller, at: AT }),
    reconsidered: () => reconsidered,
  };
}

function readStored(database: BridgeDatabase) {
  return database.read((sql) => readRequest(sql, 1));
}

function readOutbox(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT kind, request_id, payload FROM outbox ORDER BY number`);
}

describe("dismissing a request", () => {
  test("closes the revision the lead read and takes back 👀, then asks for a new wake decision", async () => {
    const database = await openLinked();
    await createStoredRequest(database, { ...revised, heldAt: 1, holdReason: "Asked the owner" });
    const { dismiss, reconsidered } = dismissFor(database);

    expect(await dismiss(1, 2)).toEqual({ request: 1 });
    expect(await readStored(database)).toMatchObject({
      state: "dismissed",
      closedReason: "Duplicate of r12",
      heldAt: null,
      holdReason: null,
    });
    expect(await readOutbox(database)).toEqual([
      {
        kind: "reaction",
        request_id: 1,
        payload: '{"action":"remove","name":"eyes","timestamp":"1700000100.000100"}',
      },
    ]);
    expect(reconsidered()).toBe(1);
  });

  test("refuses a revision the lead didn't read, changing nothing", async () => {
    const database = await openLinked();
    const request = await createStoredRequest(database, revised);
    const { dismiss, reconsidered } = dismissFor(database);

    await expect(dismiss(1, 1)).rejects.toMatchObject({
      rule: "stale_revision",
      message:
        "r1 changed since you read revision 1. Run `toy-box-slack thread r1` to read revision 2.",
    });
    await expect(dismiss(1, 3)).rejects.toMatchObject({ rule: "unknown_revision" });
    expect(await readStored(database)).toEqual(request);
    expect(await readOutbox(database)).toEqual([]);
    expect(reconsidered()).toBe(0);
  });

  test("refuses a request it can't dismiss before it looks at the revision", async () => {
    const database = await openLinked();
    await createStoredRequest(database, { ...revised, state: "open", seenAt: null });
    await createStoredLink(database, "other");
    await createStoredRequest(database, { ...revised, linkId: "other" });
    const { dismiss } = dismissFor(database);

    await expect(dismiss(1, 1)).rejects.toMatchObject({ rule: "unread_request" });
    await expect(dismiss(2, 2)).rejects.toMatchObject({ rule: "unknown_request" });
    await expect(dismiss(1, 2, { ...lead, channelId: "toybox-unlinked" })).rejects.toMatchObject({
      rule: "not_linked",
    });
    expect(await readOutbox(database)).toEqual([]);
  });
});

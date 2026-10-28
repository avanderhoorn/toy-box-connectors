import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { settleRequestAnswer } from "./answers";
import { type OutboxState } from "./database";
import { createStoredOutboxItem } from "./testFixtures";

async function setup(state: OutboxState = "sending") {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const request = await createStoredRequest(database, {
    state: "answering",
    touchedAt: 0,
  });
  await createStoredOutboxItem(database, 1, {
    state,
    slack_ts: state === "sent" || state === "retracted" ? "1700000200.000100" : null,
    evidence: state === "sent" || state === "retracted" ? "response" : null,
  });
  return { database, request };
}

function read(database: BridgeDatabase) {
  return database.read((sql) => readRequest(sql, 1));
}

function feedback(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`
      SELECT request_id, link_id, channel_id, payload, state FROM outbox
      WHERE kind = 'reaction' ORDER BY number
    `,
  );
}

describe("proof", () => {
  test.each(["queued", "sending", "delivery_unknown", "stray"] as const)(
    "%s is not delivery proof",
    async (state) => {
      const { database, request } = await setup(state);

      expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
      expect(await read(database)).toEqual(request);
      expect(await feedback(database)).toEqual([]);
    },
  );

  test.each(["failed", "dropped", "cancelled"] as const)(
    "a %s current final returns to the lead with reply_failed",
    async (state) => {
      const { database } = await setup(state);

      expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(true);

      expect(await read(database)).toMatchObject({
        state: "seen",
        attention: "reply_failed",
      });
      expect(await feedback(database)).toEqual([]);
    },
  );

  test("an old failed attempt does not defeat a replacement final", async () => {
    const { database } = await setup("failed");
    await createStoredOutboxItem(database, 2);

    expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
    expect(await read(database)).toMatchObject({ state: "answering" });
  });

  test("a retraction preserves proof of valid delivery without reopening the request", async () => {
    const { database } = await setup("retracted");

    expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(true);

    expect(await read(database)).toMatchObject({ state: "answered" });
  });

  test("progress and follow-ups never answer a request", async () => {
    const { database } = await setup("failed");
    await database.write((tx) => tx`DELETE FROM outbox`);
    await createStoredOutboxItem(database, 1, { kind: "progress", phase: null, state: "sent" });
    await createStoredOutboxItem(database, 2, { phase: "follow_up", state: "sent" });

    expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
    expect(await read(database)).toMatchObject({ state: "answering" });
    expect(await feedback(database)).toEqual([]);
  });

  test.each(["answered", "dismissed", "cancelled", "expired"] as const)(
    "a late confirmation never reopens a request that's %s",
    async (state) => {
      const { database, request } = await setup("sent");
      await database.write((tx) =>
        saveRequest(tx, {
          ...request,
          state,
          closedReason:
            state === "cancelled" ? "source_deleted" : state === "dismissed" ? "not needed" : null,
        }),
      );

      expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
      expect(await read(database)).toMatchObject({ state });
      expect(await feedback(database)).toEqual([]);
    },
  );

  test("feedback and request settlement roll back together", async () => {
    const { database, request } = await setup("sent");

    await expect(
      database.write(async (tx) => {
        await settleRequestAnswer(tx, 1, 2_000);
        throw new Error("Commit failed");
      }),
    ).rejects.toThrow("Commit failed");

    expect(await read(database)).toEqual(request);
    expect(await feedback(database)).toEqual([]);
  });
});

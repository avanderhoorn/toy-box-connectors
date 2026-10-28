import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { reviseRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import { settleRequestAnswer } from "./answers";
import { type OutboxState } from "./database";
import { createStoredOutboxItem } from "./testFixtures";

async function setup(state: OutboxState = "sending", unverified = true) {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const request = await createStoredRequest(database, {
    state: "answering",
    servedRev: 1,
    seenAt: 0,
    touchedAt: 0,
    sourceUnverifiedAt: unverified ? 1_000 : null,
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

async function prove(database: BridgeDatabase) {
  return database.write(async (tx) => {
    await tx`
      UPDATE outbox SET state = 'sent', slack_ts = '1700000200.000100', evidence = 'response'
      WHERE number = 1
    `;
    return settleRequestAnswer(tx, 1, 2_000);
  });
}

async function repair(database: BridgeDatabase, outcome: "unchanged" | "edited" | "deleted") {
  return database.write(async (tx) => {
    const request = await readRequest(tx, 1);
    if (!request) throw new Error("The test request is missing.");
    if (outcome === "deleted") {
      await cancelStoredRequest(tx, request, "source_deleted", 3_000);
    } else {
      const verified = { ...request, sourceUnverifiedAt: null };
      await saveRequest(
        tx,
        outcome === "edited" ? reviseRequest(verified, "new-input-hash", 3_000) : verified,
      );
    }
    return settleRequestAnswer(tx, 1, 3_000);
  });
}

describe("proof and source verification", () => {
  test("a confirmed current final cannot answer an unverified source", async () => {
    const { database, request } = await setup();

    expect(await prove(database)).toBe(false);

    expect(await read(database)).toEqual(request);
    expect(await feedback(database)).toEqual([]);
    expect(await database.read((sql) => sql`SELECT state FROM outbox`)).toEqual([
      { state: "sent" },
    ]);
  });

  test.each(["proof-first", "repair-first"])(
    "unchanged input settles the same way: %s",
    async (order) => {
      const { database } = await setup();
      if (order === "proof-first") {
        await prove(database);
        await repair(database, "unchanged");
      } else {
        await repair(database, "unchanged");
        await prove(database);
      }

      expect(await read(database)).toMatchObject({
        state: "answered",
        inputRev: 1,
        sourceUnverifiedAt: null,
      });
      expect(await feedback(database)).toEqual([
        {
          request_id: 1,
          link_id: "link",
          channel_id: "C-link",
          payload: '{"action":"remove","name":"eyes","timestamp":"1700000100.000100"}',
          state: "queued",
        },
        {
          request_id: 1,
          link_id: "link",
          channel_id: "C-link",
          payload: '{"action":"add","name":"white_check_mark","timestamp":"1700000100.000100"}',
          state: "queued",
        },
      ]);
      expect(await database.write((tx) => settleRequestAnswer(tx, 1, 4_000))).toBe(false);
      expect(await feedback(database)).toHaveLength(2);
    },
  );

  test.each(["proof-first", "repair-first"])(
    "an edit discovered by repair returns the stale answer: %s",
    async (order) => {
      const { database } = await setup();
      if (order === "proof-first") {
        await prove(database);
        await repair(database, "edited");
      } else {
        await repair(database, "edited");
        await prove(database);
      }

      expect(await read(database)).toMatchObject({
        state: "in_progress",
        inputRev: 2,
        sourceUnverifiedAt: null,
        attention: "updated",
      });
      expect(await feedback(database)).toEqual([]);
    },
  );

  test.each(["proof-first", "repair-first"])(
    "a deletion discovered by repair stays cancelled: %s",
    async (order) => {
      const { database } = await setup();
      if (order === "proof-first") {
        await prove(database);
        await repair(database, "deleted");
      } else {
        await repair(database, "deleted");
        await prove(database);
      }

      expect(await read(database)).toMatchObject({
        state: "cancelled",
        closedReason: "source_deleted",
      });
      expect(await feedback(database)).toEqual([]);
    },
  );

  test.each(["queued", "sending", "delivery_unknown", "stray"] as const)(
    "%s is not delivery proof",
    async (state) => {
      const { database, request } = await setup(state, false);

      expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
      expect(await read(database)).toEqual(request);
      expect(await feedback(database)).toEqual([]);
    },
  );

  test.each(["failed", "dropped", "cancelled"] as const)(
    "a %s current final returns to the lead with reply_failed",
    async (state) => {
      const { database } = await setup(state, false);

      expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(true);

      expect(await read(database)).toMatchObject({
        state: "in_progress",
        attention: "reply_failed",
      });
      expect(await feedback(database)).toEqual([]);
    },
  );

  test("a stale queued final is superseded in the revision transaction", async () => {
    const { database } = await setup("queued");

    await repair(database, "edited");

    expect(await database.read((sql) => sql`SELECT state, updated_at FROM outbox`)).toEqual([
      { state: "superseded", updated_at: 3_000 },
    ]);
    expect(await read(database)).toMatchObject({ state: "in_progress", attention: "updated" });
  });

  test("an old final does not return a request whose current final still waits", async () => {
    const { database, request } = await setup("sent", false);
    await database.write((tx) => saveRequest(tx, reviseRequest(request, "new-input", 1_000)));
    await createStoredOutboxItem(database, 2, { request_rev: 2 });

    expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
    expect(await read(database)).toMatchObject({ state: "answering", inputRev: 2 });

    await database.write(async (tx) => {
      await tx`UPDATE outbox SET state = 'sent' WHERE number = 2`;
      await settleRequestAnswer(tx, 1, 3_000);
    });
    expect(await read(database)).toMatchObject({ state: "answered", inputRev: 2 });
  });

  test("an old failed attempt does not defeat a replacement final to the same revision", async () => {
    const { database } = await setup("failed", false);
    await createStoredOutboxItem(database, 2);

    expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
    expect(await read(database)).toMatchObject({ state: "answering" });
  });

  test("a retraction preserves proof of valid delivery without reopening the request", async () => {
    const { database } = await setup("retracted");

    expect(await database.write((tx) => settleRequestAnswer(tx, 1, 2_000))).toBe(false);
    await repair(database, "unchanged");

    expect(await read(database)).toMatchObject({ state: "answered" });
  });

  test("progress and follow-ups never answer a request", async () => {
    const { database } = await setup("failed", false);
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
      const { database, request } = await setup("sent", false);
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
    const { database, request } = await setup("sent", false);

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

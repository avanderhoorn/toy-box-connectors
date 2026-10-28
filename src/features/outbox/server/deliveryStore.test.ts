import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import { purgeForUninstall } from "@links/server/purge";
import type { OutboxMethod } from "../model/delivery";
import {
  advanceReconciliation,
  expirePostSlots,
  moveOutboxChannel,
  queueCard,
  queueItem,
  readDueReconciliations,
  readOutboxItem,
  readReadyOutbox,
  recoverOutboxAttempts,
  settleOutboxAttempt,
  startOutboxAttempt,
  type NewOutboxItem,
  type OutboxItem,
  type OutboxSettlement,
} from "./database";
import { initializeOutboxSchema } from "./schema";

async function item(database: BridgeDatabase, reference: string | number): Promise<OutboxItem> {
  const found = await database.read((sql) => readOutboxItem(sql, reference));
  expect(found).not.toBeNull();
  return found!;
}

async function queue(
  database: BridgeDatabase,
  overrides: Partial<NewOutboxItem> = {},
): Promise<OutboxItem> {
  const queued = await database.write((tx) =>
    queueItem(
      tx,
      { kind: "progress", channelId: "C-one", payload: { text: "Queued" }, ...overrides },
      0,
    ),
  );
  return item(database, queued.id);
}

async function start(
  database: BridgeDatabase,
  queued: OutboxItem,
  now = 1_000,
  payload = queued.payload,
  method: OutboxMethod = "chat.postMessage",
): Promise<OutboxItem> {
  const started = await database.write((tx) =>
    startOutboxAttempt(tx, queued, payload, method, now),
  );
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("The test expected a started attempt.");
  return started.item;
}

async function unknown(database: BridgeDatabase, sending: OutboxItem): Promise<OutboxItem> {
  const result = await database.write((tx) =>
    settleOutboxAttempt(
      tx,
      sending,
      { state: "delivery_unknown", error: "timeout", nextAttemptAt: 11_000 },
      11_000,
    ),
  );
  expect(result).not.toBeNull();
  return result!;
}

describe("durable attempts", () => {
  test("reads every stored value by opaque ID or the number the lead sees", async () => {
    const database = await openTestDatabase();
    const queued = await queue(database, {
      kind: "publication",
      linkId: "link",
      publicationKey: "notes/2026-W43",
      replaces: "earlier-item",
      payload: { text: "Hello", blocks: [] },
    });

    expect(await item(database, queued.number)).toEqual(queued);
    expect(queued).toEqual({
      id: queued.id,
      number: 1,
      linkId: "link",
      requestId: null,
      approvalId: null,
      requestRev: null,
      kind: "publication",
      phase: null,
      channelId: "C-one",
      threadTs: null,
      publicationKey: "notes/2026-W43",
      replaces: "earlier-item",
      payload: { text: "Hello", blocks: [] },
      payloadHash: Bun.SHA256.hash('{"text":"Hello","blocks":[]}', "hex"),
      metadataOk: null,
      state: "queued",
      attempts: 0,
      attemptMethod: null,
      attemptStartedAt: null,
      reconcilePass: 0,
      nextAttemptAt: null,
      slackTs: null,
      error: null,
      evidence: null,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(await database.read((sql) => readOutboxItem(sql, "missing"))).toBeNull();
    expect(await database.read((sql) => readOutboxItem(sql, 999))).toBeNull();
  });

  test("commits the exact send-time card snapshot and its hash with sending", async () => {
    const database = await openTestDatabase();
    const queued = await queue(database, {
      kind: "card",
      phase: "post",
      approvalId: "approval",
      payload: {},
    });
    const message = { text: "Approved now", blocks: [], parse: "none" };

    const sending = await start(database, queued, 1_000, message);

    expect(sending).toMatchObject({
      state: "sending",
      payload: message,
      payloadHash: Bun.SHA256.hash(JSON.stringify(message), "hex"),
      attempts: 1,
      attemptMethod: "chat.postMessage",
      attemptStartedAt: 1_000,
      reconcilePass: 0,
      nextAttemptAt: null,
      updatedAt: 1_000,
    });
    expect(await item(database, queued.id)).toEqual(sending);
    expect(await database.read((sql) => readReadyOutbox(sql, 1_000))).toEqual([]);
  });

  test("an aborted sending transaction reserves neither an attempt nor a post slot", async () => {
    const database = await openTestDatabase();
    const queued = await queue(database);

    await expect(
      database.write(async (tx) => {
        await startOutboxAttempt(
          tx,
          queued,
          { text: "Send-time snapshot" },
          "chat.postMessage",
          1_000,
        );
        throw new Error("Commit failed");
      }),
    ).rejects.toThrow("Commit failed");

    expect(await item(database, queued.id)).toEqual(queued);
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
  });

  test.each([
    ["state", { state: "cancelled" }],
    ["attempt", { attempts: 1 }],
    ["payload", { payload_hash: "changed" }],
    ["channel", { channel_id: "C-new" }],
    ["queue snapshot", { updated_at: 1 }],
  ])("a changed %s cannot use a stale send-time decision", async (_name, columns) => {
    const database = await openTestDatabase();
    const queued = await queue(database);
    await database.write((tx) => tx`UPDATE outbox SET ${tx(columns)} WHERE id = ${queued.id}`);

    expect(
      await database.write((tx) =>
        startOutboxAttempt(tx, queued, queued.payload, "chat.postMessage", 1_000),
      ),
    ).toEqual({ kind: "changed" });
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
  });

  test("keeps a method's deferred item queued until its exact deadline", async () => {
    const database = await openTestDatabase();
    const sending = await start(database, await queue(database));
    const deferred = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        sending,
        { state: "queued", error: "rate_limited", nextAttemptAt: 61_000 },
        1_001,
      ),
    );
    expect(deferred).not.toBeNull();

    expect(await database.read((sql) => readReadyOutbox(sql, 60_999))).toEqual([]);
    expect(
      await database.write((tx) =>
        startOutboxAttempt(tx, deferred!, deferred!.payload, "chat.postMessage", 60_999),
      ),
    ).toEqual({ kind: "waiting", until: 61_000 });
    expect(await database.read((sql) => readReadyOutbox(sql, 61_000))).toEqual([deferred!]);
    expect(await start(database, deferred!, 61_000)).toMatchObject({
      attempts: 2,
      attemptStartedAt: 61_000,
      nextAttemptAt: null,
      error: null,
    });
  });

  test("a successful settlement retains the exact proof and metadata warning", async () => {
    const database = await openTestDatabase();
    const sending = await start(database, await queue(database));

    const sent = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        sending,
        {
          state: "sent",
          slackTs: "1700000200.000100",
          evidence: "response",
          metadataOk: false,
        },
        1_100,
      ),
    );

    expect(sent).toMatchObject({
      state: "sent",
      slackTs: "1700000200.000100",
      evidence: "response",
      metadataOk: false,
      error: null,
      attemptStartedAt: 1_000,
      updatedAt: 1_100,
    });
    expect(await item(database, sending.id)).toEqual(sent!);
  });

  test("a rate-limited retry cannot replace its stored body or method", async () => {
    const database = await openTestDatabase();
    const sending = await start(database, await queue(database));
    const queued = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        sending,
        { state: "queued", error: "rate_limited", nextAttemptAt: 2_000 },
        1_100,
      ),
    );

    await expect(
      database.write((tx) =>
        startOutboxAttempt(tx, queued!, { text: "Rendered again" }, "chat.postMessage", 2_000),
      ),
    ).rejects.toThrow("stored method and payload snapshot");
    await expect(
      database.write((tx) =>
        startOutboxAttempt(tx, queued!, queued!.payload, "chat.update", 2_000),
      ),
    ).rejects.toThrow("stored method and payload snapshot");
    expect(await item(database, queued!.id)).toEqual(queued!);
    expect((await start(database, queued!, 2_000)).payload).toEqual(sending.payload);
  });

  test("metadata cannot become part of the queued or send-time snapshot it identifies", async () => {
    const database = await openTestDatabase();
    const queued = await queue(database);
    const payload = {
      text: "Hello",
      metadata: { event_type: "toy_box_outbox", event_payload: { id: queued.id } },
    };

    await expect(queue(database, { payload })).rejects.toThrow("Add it at call time");
    await expect(
      database.write((tx) => startOutboxAttempt(tx, queued, payload, "chat.postMessage", 1_000)),
    ).rejects.toThrow("Add it at call time");
    expect(await item(database, queued.id)).toEqual(queued);
  });

  test("a misplaced receipt stays durably stray while withdrawal is attempted", async () => {
    const database = await openTestDatabase();
    const sending = await start(database, await queue(database));
    const stray = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        sending,
        {
          state: "stray",
          slackTs: "1700000200.000100",
          error: "wrong_thread",
          evidence: "response",
          metadataOk: true,
          nextAttemptAt: 1_100,
        },
        1_100,
      ),
    );
    expect(stray).toMatchObject({
      state: "stray",
      slackTs: "1700000200.000100",
      evidence: "response",
      metadataOk: true,
    });

    const withdrawn = await database.write((tx) =>
      settleOutboxAttempt(tx, stray!, { state: "failed", error: "withdrawn" }, 1_200),
    );
    expect(withdrawn).toMatchObject({
      state: "failed",
      slackTs: "1700000200.000100",
      evidence: "response",
      metadataOk: true,
      nextAttemptAt: null,
      error: "withdrawn",
    });
  });

  test("a late response cannot overwrite a manual drop", async () => {
    const database = await openTestDatabase();
    const unresolved = await unknown(database, await start(database, await queue(database)));
    await database.write(
      (tx) => tx`UPDATE outbox SET state = 'dropped' WHERE id = ${unresolved.id}`,
    );

    expect(
      await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          unresolved,
          { state: "sent", slackTs: "1700000200.000100", evidence: "metadata", metadataOk: true },
          12_000,
        ),
      ),
    ).toBeNull();
    expect((await item(database, unresolved.id)).state).toBe("dropped");
  });

  test("a late response cannot settle a newer attempt with the same payload", async () => {
    const database = await openTestDatabase();
    const first = await start(database, await queue(database));
    const deferred = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        first,
        { state: "queued", error: "rate_limited", nextAttemptAt: 2_000 },
        1_100,
      ),
    );
    const second = await start(database, deferred!, 2_000);
    expect(second.payloadHash).toBe(first.payloadHash);

    expect(
      await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          first,
          { state: "sent", slackTs: "1700000200.000100", evidence: "response", metadataOk: true },
          2_100,
        ),
      ),
    ).toBeNull();
    expect(await item(database, first.id)).toEqual(second);
  });

  test("a late response cannot settle a different payload snapshot", async () => {
    const database = await openTestDatabase();
    const sending = await start(database, await queue(database));
    await database.write(
      (tx) => tx`UPDATE outbox SET payload_hash = 'new-snapshot' WHERE id = ${sending.id}`,
    );

    expect(
      await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          sending,
          { state: "sent", slackTs: "1700000200.000100", evidence: "response", metadataOk: true },
          2_100,
        ),
      ),
    ).toBeNull();
  });

  test("a late response cannot fail an attempt that has since become unknown", async () => {
    const database = await openTestDatabase();
    const sending = await start(database, await queue(database));
    const unresolved = await unknown(database, sending);

    expect(
      await database.write((tx) =>
        settleOutboxAttempt(tx, sending, { state: "failed", error: "msg_too_long" }, 12_000),
      ),
    ).toBeNull();
    expect(await item(database, sending.id)).toEqual(unresolved);
  });

  test.each([
    { state: "queued", error: "retry", nextAttemptAt: null },
    { state: "failed", error: "not_found_is_not_proof" },
  ] satisfies OutboxSettlement[])(
    "unknown delivery cannot become $state through an automatic outcome",
    async (outcome) => {
      const database = await openTestDatabase();
      const unresolved = await unknown(database, await start(database, await queue(database)));

      await expect(
        database.write((tx) => settleOutboxAttempt(tx, unresolved, outcome, 12_000)),
      ).rejects.toThrow(`cannot settle from delivery_unknown to ${outcome.state}`);
      expect(await item(database, unresolved.id)).toEqual(unresolved);
    },
  );

  test("an older unknown with no recorded method cannot be assumed safe to retry", async () => {
    const database = await openTestDatabase();
    const unresolved = await unknown(database, await start(database, await queue(database)));
    await database.write(
      (tx) => tx`UPDATE outbox SET attempt_method = NULL WHERE id = ${unresolved.id}`,
    );
    const legacy = await item(database, unresolved.id);

    await expect(
      database.write((tx) =>
        settleOutboxAttempt(
          tx,
          legacy,
          { state: "queued", error: "unsafe_retry", nextAttemptAt: null },
          12_000,
        ),
      ),
    ).rejects.toThrow("cannot settle from delivery_unknown to queued");
  });

  test.each([
    { method: "chat.update", kind: "card", phase: "update" },
    { method: "chat.delete", kind: "retract", phase: null },
    { method: "reactions.add", kind: "reaction", phase: null },
    { method: "reactions.remove", kind: "reaction", phase: null },
    { method: "assistant.threads.setStatus", kind: "status", phase: null },
  ] as const)(
    "an uncertain $method may retry idempotently without posting",
    async ({ method, kind, phase }) => {
      const database = await openTestDatabase();
      const queued = await queue(database, { kind, phase });
      const sending = await start(database, queued, 1_000, queued.payload, method);
      const unresolved = await unknown(database, sending);

      const retry = await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          unresolved,
          { state: "queued", error: "unconfirmed_idempotent_call", nextAttemptAt: 12_000 },
          11_001,
        ),
      );

      expect(retry).toMatchObject({
        state: "queued",
        attemptMethod: method,
        attempts: 1,
        nextAttemptAt: 12_000,
      });
      expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
      expect((await start(database, retry!, 12_000, retry!.payload, method)).attempts).toBe(2);
    },
  );

  test("ready answers and retractions precede cards, progress and feedback", async () => {
    const database = await openTestDatabase();
    const reaction = await queue(database, { kind: "reaction" });
    const progress = await queue(database);
    const card = await queue(database, { kind: "card", phase: "post" });
    const reply = await queue(database, {
      kind: "reply",
      phase: "final",
      requestId: 14,
      requestRev: 1,
    });
    const retract = await queue(database, { kind: "retract" });
    const publication = await queue(database, {
      kind: "publication",
      linkId: "link",
      publicationKey: "notes",
    });

    expect(
      (await database.read((sql) => readReadyOutbox(sql, 0))).map((entry) => entry.id),
    ).toEqual([retract, reply, publication, card, progress, reaction].map((entry) => entry.id));
  });
});

describe("current card state", () => {
  const card = { approvalId: "approval", linkId: null, channelId: "C-one" };

  test.each(["post", "update"] as const)(
    "a rejected card %s can snapshot its approval's current render",
    async (phase) => {
      const database = await openTestDatabase();
      const method = phase === "post" ? "chat.postMessage" : "chat.update";
      const sending = await start(
        database,
        await queue(database, { kind: "card", phase, approvalId: card.approvalId }),
        1_000,
        { text: "Pending" },
        method,
      );
      const retry = await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          sending,
          { state: "queued", error: "rate_limited", nextAttemptAt: 2_000 },
          1_100,
        ),
      );
      const updated = await start(database, retry!, 2_000, { text: "Approved" }, method);

      expect(updated.payload).toEqual({ text: "Approved" });
      expect(updated.payloadHash).not.toBe(sending.payloadHash);
      expect(updated.attempts).toBe(2);
      expect(updated.attemptMethod).toBe(method);
    },
  );

  test("even a card retry cannot change its stored method", async () => {
    const database = await openTestDatabase();
    const sending = await start(
      database,
      await queue(database, { kind: "card", phase: "post", approvalId: card.approvalId }),
    );
    const retry = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        sending,
        { state: "queued", error: "rate_limited", nextAttemptAt: 2_000 },
        1_100,
      ),
    );

    await expect(
      database.write((tx) => startOutboxAttempt(tx, retry!, retry!.payload, "chat.update", 2_000)),
    ).rejects.toThrow("stored method and payload snapshot");
  });

  test("a card update waits for the same card's in-flight post, not another card", async () => {
    const database = await openTestDatabase();
    const post = await start(
      database,
      await queue(database, { kind: "card", phase: "post", approvalId: card.approvalId }),
    );
    const update = await queue(database, {
      kind: "card",
      phase: "update",
      approvalId: card.approvalId,
    });
    const other = await queue(database, { kind: "card", phase: "update", approvalId: "other" });

    expect(
      await database.write((tx) =>
        startOutboxAttempt(tx, update, update.payload, "chat.update", 2_000),
      ),
    ).toEqual({ kind: "waiting", until: 3_000 });
    expect(await start(database, other, 2_000, other.payload, "chat.update")).toMatchObject({
      state: "sending",
    });
    await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        post,
        { state: "sent", slackTs: "1.1", evidence: "response", metadataOk: true },
        2_100,
      ),
    );
    expect(await start(database, update, 2_100, update.payload, "chat.update")).toMatchObject({
      state: "sending",
    });
  });

  test("a newer update supersedes an older unknown without changing the card post", async () => {
    const database = await openTestDatabase();
    const post = await queue(database, {
      kind: "card",
      phase: "post",
      approvalId: card.approvalId,
    });
    const sending = await start(
      database,
      await queue(database, { kind: "card", phase: "update", approvalId: card.approvalId }),
      1_000,
      { text: "Pending" },
      "chat.update",
    );
    await unknown(database, sending);

    await database.write((tx) => queueCard(tx, { ...card, phase: "update" }, 12_000));

    expect(await item(database, sending.id)).toMatchObject({
      state: "superseded",
      nextAttemptAt: null,
    });
    expect(await item(database, post.id)).toEqual(post);
    expect(await database.read((sql) => readDueReconciliations(sql, 120_000))).toEqual([]);
    const superseded = await item(database, sending.id);
    expect(
      await database.write((tx) =>
        startOutboxAttempt(tx, superseded, sending.payload, "chat.update", 12_000),
      ),
    ).toEqual({ kind: "changed" });
  });

  test.each(["queued", "delivery_unknown"] as const)(
    "an in-flight older update cannot become a %s retry after a newer update",
    async (state) => {
      const database = await openTestDatabase();
      const sending = await start(
        database,
        await queue(database, { kind: "card", phase: "update", approvalId: card.approvalId }),
        1_000,
        { text: "Pending" },
        "chat.update",
      );
      await database.write((tx) => queueCard(tx, { ...card, phase: "update" }, 2_000));
      const replacement = (await database.read((sql) => readReadyOutbox(sql, 2_000)))[0]!;
      expect(
        await database.write((tx) =>
          startOutboxAttempt(tx, replacement, { text: "Approved" }, "chat.update", 2_000),
        ),
      ).toEqual({ kind: "waiting", until: 3_000 });
      const settled = await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          sending,
          { state, error: "response_lost_or_rejected", nextAttemptAt: 11_000 },
          2_100,
        ),
      );
      expect(settled).toMatchObject({ state: "superseded", nextAttemptAt: null });
      const latest = await start(database, replacement, 2_100, { text: "Approved" }, "chat.update");
      await database.write((tx) =>
        settleOutboxAttempt(
          tx,
          latest,
          { state: "sent", slackTs: "1.1", evidence: "response", metadataOk: true },
          2_200,
        ),
      );

      expect(await database.read((sql) => readDueReconciliations(sql, 120_000))).toEqual([]);
      expect(await database.read((sql) => readReadyOutbox(sql, 120_000))).toEqual([]);
      expect(
        await database.write((tx) =>
          settleOutboxAttempt(
            tx,
            sending,
            { state: "sent", slackTs: "1.1", evidence: "response", metadataOk: true },
            2_300,
          ),
        ),
      ).toBeNull();
      expect(await item(database, sending.id)).toMatchObject({ state: "superseded" });
      expect(await item(database, latest.id)).toMatchObject({
        state: "sent",
        payload: { text: "Approved" },
      });
    },
  );

  test("startup supersedes an interrupted older card update before any retry", async () => {
    const database = await openTestDatabase();
    const sending = await start(
      database,
      await queue(database, { kind: "card", phase: "update", approvalId: card.approvalId }),
      1_000,
      { text: "Pending" },
      "chat.update",
    );
    await database.write((tx) => queueCard(tx, { ...card, phase: "update" }, 2_000));

    expect(await database.write((tx) => recoverOutboxAttempts(tx, 3_000))).toEqual([sending.id]);
    expect(await item(database, sending.id)).toMatchObject({
      state: "superseded",
      nextAttemptAt: null,
    });
    expect(await database.read((sql) => readDueReconciliations(sql, 120_000))).toEqual([]);
    expect(await database.read((sql) => readReadyOutbox(sql, 3_000))).toHaveLength(1);
  });
});

describe("bounded reconciliation", () => {
  test("spends three complete passes at the original 10, 60 and 120 second deadlines", async () => {
    const database = await openTestDatabase();
    let unresolved = await unknown(database, await start(database, await queue(database)));
    expect(await database.read((sql) => readDueReconciliations(sql, 10_999))).toEqual([]);
    expect(await database.read((sql) => readDueReconciliations(sql, 11_000))).toEqual([unresolved]);

    for (const [pass, at, next] of [
      [1, 11_000, 61_000],
      [2, 61_000, 121_000],
      [3, 121_000, null],
    ] as const) {
      const stale = unresolved;
      const advanced = await database.write((tx) => advanceReconciliation(tx, unresolved, at));
      expect(advanced).toMatchObject({
        state: "delivery_unknown",
        reconcilePass: pass,
        nextAttemptAt: next,
        attemptStartedAt: 1_000,
        updatedAt: at,
      });
      unresolved = advanced!;
      expect(await database.write((tx) => advanceReconciliation(tx, stale, at))).toBeNull();
      expect(await database.read((sql) => readReadyOutbox(sql, at))).toEqual([]);
    }

    expect(await database.read((sql) => readDueReconciliations(sql, 999_999))).toEqual([]);
    expect(await database.write((tx) => advanceReconciliation(tx, unresolved, 999_999))).toBeNull();
    expect((await item(database, unresolved.id)).state).toBe("delivery_unknown");
  });

  test("an early or partial read cannot spend a scheduled pass", async () => {
    const database = await openTestDatabase();
    const unresolved = await unknown(database, await start(database, await queue(database)));
    expect(await database.write((tx) => advanceReconciliation(tx, unresolved, 10_999))).toBeNull();
    const deferred = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        unresolved,
        { state: "delivery_unknown", error: "rate_limited", nextAttemptAt: 61_000 },
        11_000,
      ),
    );
    expect(deferred).toMatchObject({ reconcilePass: 0, attemptStartedAt: 1_000 });
    expect(await database.read((sql) => readDueReconciliations(sql, 60_999))).toEqual([]);
    expect(await database.read((sql) => readDueReconciliations(sql, 61_000))).toEqual([deferred!]);
  });

  test("an exhausted unknown is never due again, whatever time it holds", async () => {
    const database = await openTestDatabase();
    let unresolved = await unknown(database, await start(database, await queue(database)));
    for (const at of [11_000, 61_000, 121_000]) {
      unresolved = (await database.write((tx) => advanceReconciliation(tx, unresolved, at)))!;
    }
    const deferred = await database.write((tx) =>
      settleOutboxAttempt(
        tx,
        unresolved,
        { state: "delivery_unknown", error: "rate_limited", nextAttemptAt: 181_000 },
        121_000,
      ),
    );

    expect(deferred).toMatchObject({ reconcilePass: 3, nextAttemptAt: 181_000 });
    expect(await database.read((sql) => readDueReconciliations(sql, 181_000))).toEqual([]);
  });

  test("startup recovery and the channel slot survive closing and reopening the file", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const first = await openBridgeDatabase(path);
    const sending = await start(first, await queue(first));
    await first.close();
    const database = await openBridgeDatabase(path);
    onTestFinished(() => database.close());
    const queued = await queue(database);

    expect(await database.write((tx) => recoverOutboxAttempts(tx, 1_500))).toEqual([sending.id]);
    expect(await item(database, sending.id)).toMatchObject({
      state: "delivery_unknown",
      error: "interrupted",
      attempts: 1,
      attemptStartedAt: 1_000,
      nextAttemptAt: 11_000,
    });
    expect(await database.write((tx) => recoverOutboxAttempts(tx, 2_000))).toEqual([]);
    expect(await database.read((sql) => readReadyOutbox(sql, 1_500))).toEqual([queued]);
    expect(
      await database.write((tx) =>
        startOutboxAttempt(tx, queued, queued.payload, "chat.postMessage", 1_999),
      ),
    ).toEqual({ kind: "waiting", until: 2_000 });
    expect(await start(database, queued, 2_000)).toMatchObject({ state: "sending" });
  });
});

describe("shared channel post slots", () => {
  test("two links and a card share one second, but another channel does not wait", async () => {
    const database = await openTestDatabase();
    const publication = await queue(database, {
      kind: "publication",
      linkId: "one",
      publicationKey: "notes",
    });
    const card = await queue(database, { kind: "card", phase: "post", linkId: "two" });
    const other = await queue(database, { channelId: "C-other" });

    const [posted, held] = await Promise.all([
      database.write((tx) =>
        startOutboxAttempt(tx, publication, publication.payload, "chat.postMessage", 1_000),
      ),
      database.write((tx) => startOutboxAttempt(tx, card, card.payload, "chat.postMessage", 1_000)),
    ]);

    expect(posted.kind).toBe("started");
    expect(held).toEqual({ kind: "waiting", until: 2_000 });
    expect(await item(database, card.id)).toEqual(card);
    expect(await start(database, other)).toMatchObject({ state: "sending" });
    expect(
      await database.write((tx) =>
        startOutboxAttempt(tx, card, card.payload, "chat.postMessage", 1_999),
      ),
    ).toEqual({ kind: "waiting", until: 2_000 });
    expect(await start(database, card, 2_000)).toMatchObject({ state: "sending" });
  });

  test("updates and feedback neither wait for nor extend a channel's post slot", async () => {
    const database = await openTestDatabase();
    await start(database, await queue(database));
    const update = await queue(database, { kind: "card", phase: "update" });
    const feedback = await queue(database, { kind: "reaction" });

    await start(database, update, 1_001, update.payload, "chat.update");
    await start(database, feedback, 1_002, feedback.payload, "reactions.add");

    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([
      { channel_id: "C-one", next_post_at: 2_000 },
    ]);
  });

  test.each([1_500, 3_000])(
    "moving a channel carries the later of its two slots (%s)",
    async (newAt) => {
      const database = await openTestDatabase();
      await database.write(async (tx) => {
        await tx`INSERT INTO outbox_channels VALUES ('C-one', 2000), ('C-new', ${newAt})`;
        await moveOutboxChannel(tx, "C-one", "C-new");
      });

      expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([
        { channel_id: "C-new", next_post_at: Math.max(2_000, newAt) },
      ]);
      await database.write((tx) => moveOutboxChannel(tx, "C-new", "C-new"));
      expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([
        { channel_id: "C-new", next_post_at: Math.max(2_000, newAt) },
      ]);
    },
  );

  test("maintenance removes only expired slots, and uninstall removes the remaining slots", async () => {
    const database = await openTestDatabase();
    await database.write(async (tx) => {
      await tx`INSERT INTO outbox_channels VALUES ('C-old', 999), ('C-due', 1000), ('C-new', 1001)`;
      await expirePostSlots(tx, 1_000);
    });
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([
      { channel_id: "C-new", next_post_at: 1_001 },
    ]);

    await database.write((tx) => purgeForUninstall(tx, 1_001));

    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
  });
});

describe("version 1 upgrades", () => {
  test("preserves old items and searches from queue time, not a later response time", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const old = await openBridgeDatabase(path, [initializeOutboxSchema]);
    const queued = await old.write((tx) =>
      queueItem(tx, { kind: "progress", channelId: "C-one", payload: { text: "Old" } }, 1_000),
    );
    await old.write(
      (tx) => tx`
        UPDATE outbox SET state = 'delivery_unknown', attempts = 1, updated_at = 11000
        WHERE id = ${queued.id}
      `,
    );
    await old.close();

    const database = await openBridgeDatabase(path);
    onTestFinished(() => database.close());

    expect(await item(database, queued.id)).toMatchObject({
      state: "delivery_unknown",
      payload: { text: "Old" },
      attempts: 1,
      attemptStartedAt: 1_000,
      reconcilePass: 0,
      nextAttemptAt: 11_000,
      createdAt: 1_000,
      updatedAt: 11_000,
    });
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([
      { channel_id: "C-one", next_post_at: 12_000 },
    ]);
    expect(await database.read((sql) => sql`PRAGMA user_version`)).toEqual([{ user_version: 2 }]);
  });

  test.each([
    { attempt_method: "not.a.write" },
    { attempt_started_at: -1 },
    { attempt_started_at: 0.5 },
    { reconcile_pass: -1 },
    { reconcile_pass: 0.5 },
    { reconcile_pass: 4 },
    { reconcile_pass: null },
  ])("rejects invalid attempt fields: %j", async (columns) => {
    const database = await openTestDatabase();
    const queued = await queue(database);

    await expect(
      database.write((tx) => tx`UPDATE outbox SET ${tx(columns)} WHERE id = ${queued.id}`),
    ).rejects.toThrow();
  });
});

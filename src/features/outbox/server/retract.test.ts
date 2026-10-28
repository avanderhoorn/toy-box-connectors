import { expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { writeChannelInfo } from "@slackapi/server/channels";
import { markAuthFailed, readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import { renderMarkdown } from "../model/rendering";
import {
  queueItem,
  queueRetraction,
  readOutboxItem,
  recoverOutboxAttempts,
  startOutboxAttempt,
} from "./database";
import { createPostDelivery } from "./posts";
import { createRetraction } from "./retract";

async function setup({ misplaced = true, publication = false } = {}) {
  let at = 1_700_000_200_000;
  const now = () => at;
  const database = await openTestDatabase();
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  onTestFinished(() => slack.stop());
  slack.addChannel({ id: "C-link", is_private: true, members: ["U-owner", "U-bot"] });
  await createStoredInstallation(database);
  await createStoredLink(database);
  await database.write((tx) => writeChannelInfo(tx, channelFacts(), now()));
  const request = await createStoredRequest(database, {
    state: "answering",
    servedRev: 1,
    seenAt: at - 10_000,
    touchedAt: at - 10_000,
  });
  slack.setMessage("C-link", { ts: request.sourceTs, text: "Question", user: "U-owner" });
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs: 100,
    now,
  });
  const rendered = renderMarkdown("A safe answer.");
  if (rendered.kind !== "rendered") throw new Error("The fixture needs rendered output.");
  const queued = await database.write((tx) =>
    queueItem(
      tx,
      {
        kind: publication ? "publication" : "reply",
        phase: publication ? null : "final",
        linkId: "link",
        requestId: publication ? null : request.id,
        requestRev: publication ? null : request.inputRev,
        publicationKey: publication ? "release-notes/2023-11-14" : null,
        channelId: "C-link",
        threadTs: publication ? null : request.rootTs,
        payload: { ...rendered.message },
      },
      now(),
    ),
  );
  if (misplaced) slack.failNext("chat.postMessage", { misplacedReply: true });
  await createPostDelivery(database, bot, { now }).post(queued.id);
  const original = await database.read((sql) => readOutboxItem(sql, queued.id));
  if (!original || original.slackTs === null) throw new Error("The fixture needs a proved post.");
  const operation = await database.write((tx) => queueRetraction(tx, original, now()));
  const read = () => database.read((sql) => readOutboxItem(sql, operation.id));
  const readOriginal = () => database.read((sql) => readOutboxItem(sql, original.id));
  const readQuestion = () => database.read((sql) => readRequest(sql, request.id));
  return {
    database,
    slack,
    bot,
    original,
    operation,
    request,
    now,
    read,
    readOriginal,
    readQuestion,
    retract: createRetraction(database, bot, { now }).retract,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("withdrawing a misplaced reply deletes it, returns the question and never invents delivery proof", async () => {
  const { database, slack, original, operation, retract, readOriginal, readQuestion, read } =
    await setup();
  const slots = await database.read((sql) => sql`SELECT * FROM outbox_channels`);
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", attemptMethod: "chat.delete", attempts: 1 },
  });
  expect(await read()).toMatchObject({ payload: { target: original.id, ts: original.slackTs } });
  expect(await readOriginal()).toMatchObject({
    state: "failed",
    error: "misplaced_reply_withdrawn",
    slackTs: original.slackTs,
    evidence: original.evidence,
  });
  expect(await readQuestion()).toMatchObject({ state: "in_progress", attention: "reply_failed" });
  expect(slack.getMessages("C-link").map((message) => message.ts)).not.toContain(original.slackTs);
  expect(slack.calls.at(-1)).toMatchObject({
    method: "chat.delete",
    args: { channel: "C-link", ts: original.slackTs },
  });
  expect(slack.calls.at(-1)!.args).toEqual({ channel: "C-link", ts: original.slackTs });
  expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual(slots);
  expect(await retract(operation.id)).toEqual({ kind: "changed" });
  expect(slack.calls).toHaveLength(2);
});

test.each([false, true])(
  "retracting a confirmed publication=%s preserves valid proof and its key",
  async (publication) => {
    const { database, original, operation, retract, readOriginal, readQuestion, now } = await setup(
      { misplaced: false, publication },
    );
    expect(await retract(operation.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
    expect(await readOriginal()).toMatchObject({
      state: "retracted",
      slackTs: original.slackTs,
      evidence: original.evidence,
      payloadHash: original.payloadHash,
      publicationKey: original.publicationKey,
    });
    expect(await readQuestion()).toMatchObject({ state: publication ? "answering" : "answered" });
    await expect(
      database.write((tx) =>
        queueItem(
          tx,
          {
            kind: original.kind,
            phase: original.phase,
            linkId: original.linkId,
            requestId: original.requestId,
            requestRev: original.requestRev,
            channelId: original.channelId,
            threadTs: original.threadTs,
            publicationKey: original.publicationKey,
            payload: original.payload,
          },
          now(),
        ),
      ),
    ).rejects.toThrow("UNIQUE");
  },
);

test("a suspended link and invalidated facts never block removal of its misplaced post", async () => {
  const { database, slack, operation, retract, now } = await setup();
  await database.write(async (tx) => {
    await tx`UPDATE links SET status = 'suspended', status_reason = 'channel_restricted'`;
    await tx`UPDATE channel_info SET invalidated_at = ${now()}`;
  });
  expect(await retract(operation.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.delete"]);
});

test("an inactive installation leaves its cleanup queued without a deletion attempt", async () => {
  const { database, slack, operation, retract, read, now } = await setup();
  await database.write((tx) => markAuthFailed(tx, now()));
  expect(await retract(operation.id)).toEqual({
    kind: "waiting",
    reason: "installation_inactive",
    until: null,
  });
  expect(await read()).toMatchObject({ state: "queued", attempts: 0 });
  expect(slack.calls).toHaveLength(1);
});

test("a deletion 429 preserves its snapshot and waits for the exact shared deadline", async () => {
  const { slack, operation, retract, read, now, advance } = await setup();
  slack.failNext("chat.delete", { retryAfter: 2 });
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "queued", nextAttemptAt: now() + 2_000 },
  });
  const first = await read();
  expect(await retract(operation.id)).toEqual({
    kind: "waiting",
    reason: "rate_limited",
    until: now() + 2_000,
  });
  advance(1_999);
  expect(await retract(operation.id)).toMatchObject({ kind: "waiting" });
  advance(1);
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", attempts: 2, payloadHash: first!.payloadHash },
  });
  const calls = slack.calls.filter((call) => call.method === "chat.delete");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.args).toEqual(calls[1]!.args);
});

test.each(["lostResponse", "internal_error", "fatal_error", "service_unavailable", "HTTP 503"])(
  "an uncertain deletion can retry the same target safely: %s",
  async (failure) => {
    const { slack, original, operation, retract, readOriginal, now, advance } = await setup();
    slack.failNext(
      "chat.delete",
      failure === "lostResponse"
        ? { lostResponse: true }
        : failure === "HTTP 503"
          ? { status: 503 }
          : { error: failure, afterWrite: true },
    );
    expect(await retract(operation.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued", nextAttemptAt: now() + 5_000 },
    });
    expect(await readOriginal()).toMatchObject({ state: "stray" });
    expect(await retract(operation.id)).toEqual({
      kind: "waiting",
      reason: "retry_after",
      until: now() + 5_000,
    });
    advance(5_000);
    expect(await retract(operation.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
    expect(await readOriginal()).toMatchObject({
      state: "failed",
      error: "misplaced_reply_withdrawn",
    });
    expect(slack.getMessages("C-link").map((message) => message.ts)).not.toContain(
      original.slackTs,
    );
    expect(slack.calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "chat.delete",
      "chat.delete",
    ]);
  },
);

test("repeated uncertain deletions back off from five seconds to a two-minute cap", async () => {
  const { slack, operation, retract, now, advance } = await setup();
  for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
    slack.failNext("chat.delete", { status: 503 });
    expect(await retract(operation.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued", nextAttemptAt: now() + delay },
    });
    advance(delay);
  }
  expect(await retract(operation.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(slack.calls.filter((call) => call.method === "chat.delete")).toHaveLength(8);
});

test("an interrupted delete resumes idempotently after crash recovery, without reading or reposting", async () => {
  const { database, slack, bot, original, operation, retract, read, readOriginal, now, advance } =
    await setup();
  await database.write(async (tx) => {
    const item = await readOutboxItem(tx, operation.id);
    if (!item) throw new Error("The queued cleanup disappeared.");
    await startOutboxAttempt(
      tx,
      item,
      { target: original.id, ts: original.slackTs },
      "chat.delete",
      now(),
    );
  });
  await bot.call("chat.delete", (client) =>
    client.chat.delete({
      channel: original.channelId,
      ts: original.slackTs!,
    }),
  );
  await database.write((tx) => recoverOutboxAttempts(tx, now()));
  expect(await read()).toMatchObject({ state: "delivery_unknown", attempts: 1 });
  expect(await retract(operation.id)).toEqual({
    kind: "waiting",
    reason: "retry_after",
    until: now() + 10_000,
  });
  advance(10_000);
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", attempts: 2 },
  });
  expect(await readOriginal()).toMatchObject({
    state: "failed",
    error: "misplaced_reply_withdrawn",
  });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "chat.delete",
    "chat.delete",
  ]);
});

test.each(["channel", "timestamp", "missing_timestamp"])(
  "an accepted but contradictory deletion response is not proof: %s",
  async (field) => {
    const { database, slack, bot, operation, readOriginal, now, advance } = await setup();
    const contradictory: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      call(method, run) {
        return bot.call(method, async (client) => {
          const original = client.chat.delete;
          client.chat.delete = async (args) => {
            const result = await original(args);
            return {
              ...result,
              ...(field === "channel"
                ? { channel: "C-other" }
                : { ts: field === "timestamp" ? "1.000100" : undefined }),
            };
          };
          try {
            return await run(client);
          } finally {
            client.chat.delete = original;
          }
        });
      },
    };
    expect(
      await createRetraction(database, contradictory, { now }).retract(operation.id),
    ).toMatchObject({
      kind: "settled",
      item: { state: "queued", error: "invalid_delete_response" },
    });
    expect(await readOriginal()).toMatchObject({ state: "stray" });
    advance(5_000);
    expect(await createRetraction(database, bot, { now }).retract(operation.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(slack.calls).toHaveLength(3);
  },
);

test("a failed withdrawal remains stray with Slack's error, and an explicit retry can remove it", async () => {
  const { database, slack, original, operation, retract, readOriginal, now } = await setup();
  slack.failNext("chat.delete", { error: "cant_delete_message" });
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "cant_delete_message" },
  });
  expect(await readOriginal()).toMatchObject({ state: "stray", error: "cant_delete_message" });
  const retry = await database.write((tx) => queueRetraction(tx, original, now()));
  expect(retry.id).not.toBe(operation.id);
  expect(await retract(retry.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(await readOriginal()).toMatchObject({
    state: "failed",
    error: "misplaced_reply_withdrawn",
  });
});

test("a channel-wide refusal suspends its links and leaves the misplaced post visible", async () => {
  const { database, slack, operation, retract, readOriginal } = await setup();
  slack.failNext("chat.delete", { error: "restricted_action" });
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "restricted_action" },
  });
  expect(await readOriginal()).toMatchObject({ state: "stray", error: "restricted_action" });
  expect(
    await database.read((sql) => sql`SELECT status, status_reason FROM links WHERE id = 'link'`),
  ).toEqual([{ status: "suspended", status_reason: "channel_restricted" }]);
});

test("a revoked token retains queued cleanup, and subsequent calls wait without contacting Slack", async () => {
  const { database, slack, operation, retract, readOriginal } = await setup();
  slack.failNext("chat.delete", { error: "token_revoked" });
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "queued", error: "token_revoked", nextAttemptAt: null },
  });
  expect(await database.read(readInstallation)).toMatchObject({ status: "auth_failed" });
  expect(await retract(operation.id)).toEqual({
    kind: "waiting",
    reason: "installation_inactive",
    until: null,
  });
  expect(await readOriginal()).toMatchObject({ state: "stray" });
  expect(slack.calls).toHaveLength(2);
});

test.each(["channel_id", "link_id", "request_id", "thread_ts"])(
  "a retraction cannot cross its target's %s",
  async (column) => {
    const { database, slack, operation, retract, readOriginal } = await setup();
    const values: Record<string, string | null> = {
      channel_id: "C-other",
      link_id: null,
      request_id: null,
      thread_ts: "1.000100",
    };
    await database.write(
      (tx) => tx`UPDATE outbox SET ${tx({ [column]: values[column] })} WHERE id = ${operation.id}`,
    );
    expect(await retract(operation.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error: "target_mismatch", attempts: 0 },
    });
    expect(await readOriginal()).toMatchObject({ state: "stray" });
    expect(slack.calls).toHaveLength(1);
  },
);

test.each([
  {},
  { target: "" },
  { target: 12 },
  { target: "x", ts: "bad" },
  { target: "x", extra: true },
])("a malformed withdrawal payload is refused before a call: %j", async (payload) => {
  const { database, slack, operation, retract } = await setup();
  const encoded = JSON.stringify(payload);
  await database.write(
    (tx) => tx`UPDATE outbox SET payload = ${encoded},
      payload_hash = ${Bun.SHA256.hash(encoded, "hex")} WHERE id = ${operation.id}`,
  );
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "invalid_retract_payload", attempts: 0 },
  });
  expect(slack.calls).toHaveLength(1);
});

test.each([
  { state: "delivery_unknown" },
  { state: "queued" },
  { slack_ts: null },
  { evidence: null },
  { state: "sent", kind: "card", phase: "post" },
])("an unproved or protected target is never deleted: %j", async (changes) => {
  const { database, slack, original, operation, retract } = await setup();
  await database.write((tx) => tx`UPDATE outbox SET ${tx(changes)} WHERE id = ${original.id}`);
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "target_unconfirmed", attempts: 0 },
  });
  expect(slack.calls).toHaveLength(1);
});

test("a missing target drops cleanup explicitly without contacting Slack", async () => {
  const { database, slack, original, operation, retract } = await setup();
  await database.write((tx) => tx`DELETE FROM outbox WHERE id = ${original.id}`);
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "dropped", error: "target_missing" },
  });
  expect(slack.calls).toHaveLength(1);
});

test.each([{ state: "retracted" }, { state: "failed", error: "misplaced_reply_withdrawn" }])(
  "an already withdrawn target drops a redundant operation: %j",
  async (changes) => {
    const { database, slack, original, operation, retract } = await setup();
    await database.write((tx) => tx`UPDATE outbox SET ${tx(changes)} WHERE id = ${original.id}`);
    expect(await retract(operation.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "already_withdrawn", attempts: 0 },
    });
    expect(slack.calls).toHaveLength(1);
  },
);

test("a legacy interrupted deletion without a target snapshot is refused, not guessed", async () => {
  const { database, slack, operation, retract } = await setup();
  await database.write(
    (tx) => tx`UPDATE outbox SET state = 'delivery_unknown', attempts = 1,
    attempt_method = 'chat.delete' WHERE id = ${operation.id}`,
  );
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "invalid_retract_payload", attempts: 1 },
  });
  expect(slack.calls).toHaveLength(1);
});

test("a queued item for another method cannot enter the deletion handler", async () => {
  const { database, slack, operation, retract } = await setup();
  await database.write((tx) => tx`UPDATE outbox SET kind = 'reaction' WHERE id = ${operation.id}`);
  await expect(retract(operation.id)).rejects.toThrow("cannot use chat.delete");
  expect(slack.calls).toHaveLength(1);
});

test("recovery never retries a cleanup item that recorded another method", async () => {
  const { database, slack, operation, retract, read } = await setup();
  await database.write(
    (tx) => tx`UPDATE outbox SET state = 'delivery_unknown',
    attempt_method = 'chat.postMessage', attempts = 1 WHERE id = ${operation.id}`,
  );
  await expect(retract(operation.id)).rejects.toThrow("no interrupted deletion");
  expect(await read()).toMatchObject({
    state: "delivery_unknown",
    attemptMethod: "chat.postMessage",
  });
  expect(slack.calls).toHaveLength(1);
});

test("a changed stored target timestamp never retargets a retry", async () => {
  const { database, slack, original, operation, retract, advance } = await setup();
  slack.failNext("chat.delete", { retryAfter: 1 });
  await retract(operation.id);
  await database.write(
    (tx) => tx`UPDATE outbox SET slack_ts = '1.000100' WHERE id = ${original.id}`,
  );
  advance(1_000);
  expect(await retract(operation.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "target_mismatch", attempts: 1 },
  });
  expect(slack.calls).toHaveLength(2);
});

test("a late delete response cannot overwrite a manual resolution or change its target", async () => {
  const { database, bot, original, operation, now, readOriginal, read } = await setup();
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    async call(method, run) {
      const result = await bot.call(method, run);
      received.resolve();
      await release.promise;
      return result;
    },
  };
  const service = createRetraction(database, held, { now });
  const pending = service.retract(operation.id);
  await received.promise;
  try {
    expect(await read()).toMatchObject({
      state: "sending",
      attemptMethod: "chat.delete",
      attempts: 1,
    });
    expect(await service.retract(operation.id)).toEqual({ kind: "changed" });
    await database.write(
      (tx) => tx`UPDATE outbox SET state = 'dropped' WHERE id = ${operation.id}`,
    );
  } finally {
    release.resolve();
  }
  expect(await pending).toEqual({ kind: "changed" });
  expect(await read()).toMatchObject({ state: "dropped" });
  expect(await readOriginal()).toMatchObject({ id: original.id, state: "stray" });
});

test("the deletion, original and request commit together, and recovery finishes after a rollback", async () => {
  const { database, operation, retract, read, readOriginal, readQuestion, now, advance } =
    await setup();
  await database.write((tx) =>
    tx.unsafe(`CREATE TRIGGER reject_cleanup_answer
    BEFORE UPDATE ON requests WHEN NEW.attention = 'reply_failed'
    BEGIN SELECT RAISE(ABORT, 'cleanup answer failed'); END`),
  );
  await expect(retract(operation.id)).rejects.toThrow("cleanup answer failed");
  expect(await read()).toMatchObject({ state: "sending" });
  expect(await readOriginal()).toMatchObject({ state: "stray" });
  expect(await readQuestion()).toMatchObject({ state: "answering" });
  await database.write(async (tx) => {
    await tx.unsafe("DROP TRIGGER reject_cleanup_answer");
    await recoverOutboxAttempts(tx, now());
  });
  advance(10_000);
  expect(await retract(operation.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(await readOriginal()).toMatchObject({ state: "failed" });
  expect(await readQuestion()).toMatchObject({ state: "in_progress", attention: "reply_failed" });
});

test.each(["queued", "sending", "delivery_unknown", "sent"])(
  "repeated cleanup shares an existing %s operation",
  async (state) => {
    const { database, original, operation, now } = await setup();
    await database.write((tx) => tx`UPDATE outbox SET state = ${state} WHERE id = ${operation.id}`);
    expect(await database.write((tx) => queueRetraction(tx, original, now()))).toEqual(operation);
  },
);

test("an existing cleanup with another scope never poisons the target's legitimate operation", async () => {
  const { database, original, operation, now } = await setup();
  await database.write((tx) => tx`UPDATE outbox SET link_id = NULL WHERE id = ${operation.id}`);
  const queued = await database.write((tx) => queueRetraction(tx, original, now()));
  expect(queued.id).not.toBe(operation.id);
  expect(await database.read((sql) => readOutboxItem(sql, queued.id))).toMatchObject({
    linkId: original.linkId,
    channelId: original.channelId,
    requestId: original.requestId,
    threadTs: original.threadTs,
    payload: { target: original.id },
  });
});

test("a different target gets a separate cleanup operation", async () => {
  const { database, original, operation, now } = await setup();
  const other = await database.write(async (tx) => {
    const queued = await queueItem(
      tx,
      {
        kind: "progress",
        linkId: original.linkId,
        channelId: original.channelId,
        payload: {},
      },
      now(),
    );
    const target = await readOutboxItem(tx, queued.id);
    if (!target) throw new Error("The second target disappeared.");
    return queueRetraction(tx, target, now());
  });
  expect(other.id).not.toBe(operation.id);
});

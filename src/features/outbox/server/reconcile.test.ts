import { expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { readApproval, staleApprovals } from "@links/server/approvals";
import { createStoredApproval, createStoredLink } from "@links/server/testFixtures";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { compareTs, tsAt } from "@slackapi/model/ts";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import { renderMarkdown } from "../model/rendering";
import { settleRequestAnswer } from "./answers";
import {
  queueCard,
  queueItem,
  readDueReconciliations,
  readOutboxItem,
  readReadyOutbox,
} from "./database";
import { createPostDelivery } from "./posts";
import { createReconciliation } from "./reconcile";

async function setup({
  kind = "reply",
  pageSize = 2,
  misplaced = false,
  slackClockOffsetMs = 0,
}: {
  kind?: "reply" | "publication" | "card";
  pageSize?: number;
  misplaced?: boolean;
  slackClockOffsetMs?: number;
} = {}) {
  let at = 1_700_000_200_000;
  const now = () => at;
  const database = await openTestDatabase();
  const slack = startFakeSlack({
    now: () => now() + slackClockOffsetMs,
    pageSize,
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
  slack.setMessage("C-link", {
    type: "message",
    ts: request.sourceTs,
    text: "Question",
    user: "U-owner",
  });
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs: 40,
    now,
  });
  const delivery = createPostDelivery(database, bot, { now });
  const approval =
    kind === "card"
      ? await createStoredApproval(database, {
          card: { channelId: "C-link", ts: null },
          createdAt: at,
          expiresAt: at + 3_600_000,
        })
      : null;
  const rendered = renderMarkdown("A safe **answer**.");
  if (rendered.kind !== "rendered") throw new Error("The fixture needs rendered output.");
  await database.write(async (tx) => {
    if (approval) {
      await queueCard(
        tx,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      );
    } else {
      await queueItem(
        tx,
        {
          kind,
          phase: kind === "reply" ? "final" : null,
          linkId: "link",
          requestId: kind === "reply" ? request.id : null,
          requestRev: kind === "reply" ? request.inputRev : null,
          publicationKey: kind === "publication" ? "release-notes/2023-11-14" : null,
          channelId: "C-link",
          threadTs: kind === "reply" ? request.rootTs : null,
          payload: { ...rendered.message },
        },
        now(),
      );
    }
  });
  const item = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
  at += 2_000;
  slack.failNext(
    "chat.postMessage",
    misplaced ? { misplacedReply: true, lostResponse: true } : { lostResponse: true },
  );
  expect(await delivery.post(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown" },
  });
  const read = () => database.read((sql) => readOutboxItem(sql, item.id));
  const posted = slack.getMessages("C-link").find((message) => message.bot_id === "B-bot")!;
  const reconciliation = createReconciliation(database, bot, { now });
  onTestFinished(() => reconciliation.close());
  at += 10_000;
  return {
    database,
    slack,
    bot,
    delivery,
    item,
    read,
    request,
    approval,
    posted,
    now,
    reconcile: reconciliation.reconcile,
    reconciliation,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("a complete thread read finds exact metadata, commits proof and answers in one transaction", async () => {
  const { database, slack, item, request, reconcile } = await setup({ pageSize: 1 });
  slack.emptyNextPage("conversations.replies");

  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", evidence: "metadata", metadataOk: true },
  });
  expect(await database.read((sql) => readRequest(sql, request.id))).toMatchObject({
    state: "answered",
  });
  expect(
    await database.read((sql) => sql`SELECT kind FROM outbox WHERE kind = 'reaction'`),
  ).toHaveLength(2);
  const reads = slack.calls.filter((call) => call.method === "conversations.replies");
  expect(reads.length).toBeGreaterThan(1);
  for (const call of reads) {
    expect(call.args).toMatchObject({
      channel: "C-link",
      ts: request.rootTs,
      include_all_metadata: "true",
      limit: "200",
    });
    expect(call.args).not.toHaveProperty("oldest");
    expect(call.args).not.toHaveProperty("latest");
  }
  expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("publication roots page from the attempt rather than the queue time", async () => {
  const { slack, item, reconcile, now, read } = await setup({ kind: "publication", pageSize: 1 });
  slack.emptyNextPage("conversations.history");
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  const stored = await read();
  expect(stored!.createdAt).toBeLessThan(stored!.attemptStartedAt!);
  const reads = slack.calls.filter((call) => call.method === "conversations.history");
  expect(reads.length).toBeGreaterThan(1);
  expect(reads[0]!.args).toMatchObject({
    oldest: tsAt(stored!.attemptStartedAt! - gapOverlapMs),
    inclusive: "true",
    include_all_metadata: "true",
  });
  expect(stored!.attemptStartedAt).toBe(now() - 10_000);
});

test.each(["publication", "card", "misplaced_reply"] as const)(
  "clock overlap finds a %s stamped one second before this Mac's attempt time",
  async (kind) => {
    const { slack, item, posted, read, reconcile } = await setup({
      kind: kind === "misplaced_reply" ? "reply" : kind,
      misplaced: kind === "misplaced_reply",
      slackClockOffsetMs: -1_000,
    });
    const before = await read();
    expect(compareTs(posted.ts, tsAt(before!.attemptStartedAt!))).toBeLessThan(0);
    expect(await reconcile(item.id)).toMatchObject({
      kind: "settled",
      item: { state: kind === "misplaced_reply" ? "stray" : "sent" },
    });
    const history = slack.calls.find((call) => call.method === "conversations.history")!;
    expect(history.args.oldest).toBe(tsAt(before!.attemptStartedAt! - gapOverlapMs));
    expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  },
);

test("a lost reply response can be correlated at root and queues withdrawal without answering", async () => {
  const { database, slack, item, reconcile, request } = await setup({ misplaced: true });
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "stray", evidence: "metadata", metadataOk: true, error: "wrong_thread" },
  });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "conversations.replies",
    "conversations.history",
  ]);
  expect(await database.read((sql) => readRequest(sql, request.id))).toMatchObject({
    state: "answering",
  });
  expect(
    await database.read((sql) => sql`SELECT payload FROM outbox WHERE kind = 'retract'`),
  ).toEqual([{ payload: JSON.stringify({ target: item.id }) }]);
});

test("initial card proof records its ts and releases the current decision update", async () => {
  const { database, slack, item, approval, posted, reconcile, delivery, now } = await setup({
    kind: "card",
  });
  await database.write((tx) => staleApprovals(tx, [approval!], "link_changed", now()));
  const update = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
  expect(await delivery.updateCard(update.id)).toMatchObject({
    kind: "waiting",
    reason: "card_not_posted",
  });
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(await database.read((sql) => readApproval(sql, approval!.id))).toMatchObject({
    state: "stale",
    card: { ts: posted.ts },
  });
  expect(await delivery.updateCard(update.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "conversations.history",
    "chat.update",
  ]);
});

test("an unknown card edit reads its older known target and never repeats the update", async () => {
  const { database, slack, item, approval, posted, reconcile, delivery, now, advance } =
    await setup({ kind: "card" });
  await reconcile(item.id);
  const current = await database.read((sql) => readApproval(sql, approval!.id));
  await database.write((tx) => staleApprovals(tx, [current!], "link_changed", now()));
  const update = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
  slack.failNext("chat.update", { lostResponse: true });
  expect(await delivery.updateCard(update.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown" },
  });
  advance(10_000);
  expect(await reconcile(update.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", slackTs: posted.ts, evidence: "metadata" },
  });
  expect(slack.calls.at(-1)!.args).toMatchObject({
    oldest: posted.ts,
    latest: posted.ts,
    inclusive: "true",
    include_all_metadata: "true",
  });
  expect(slack.calls.filter((call) => call.method === "chat.update")).toHaveLength(1);
});

test("read proof cannot answer an unverified source until repair settles it", async () => {
  const { database, item, request, now, reconcile } = await setup();
  await database.write((tx) => saveRequest(tx, { ...request, sourceUnverifiedAt: now() }));
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(await database.read((sql) => readRequest(sql, request.id))).toMatchObject({
    state: "answering",
    sourceUnverifiedAt: now(),
  });
  await database.write(async (tx) => {
    await saveRequest(tx, { ...request, sourceUnverifiedAt: null });
    await settleRequestAnswer(tx, request.id, now());
  });
  expect(await database.read((sql) => readRequest(sql, request.id))).toMatchObject({
    state: "answered",
  });
});

test("three complete misses spend the original deadlines and never permit another post", async () => {
  const { slack, item, posted, now, advance, reconcile } = await setup();
  slack.deleteMessage("C-link", posted.ts);
  const attempt = now() - 10_000;
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 1, nextAttemptAt: attempt + 60_000 },
  });
  advance(49_999);
  const count = slack.calls.length;
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "retry_after",
    until: attempt + 60_000,
  });
  expect(slack.calls).toHaveLength(count);
  advance(1);
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 2, nextAttemptAt: attempt + 120_000 },
  });
  advance(60_000);
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 3, nextAttemptAt: null },
  });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "reconciliation_stopped",
    until: null,
  });
  expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("a second-page rate limit spends no pass and continues after its cooldown", async () => {
  const { database, slack, bot, item, now, advance, read } = await setup({ pageSize: 1 });
  let reads = 0;
  const limited: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    call(method, run) {
      if (method === "conversations.replies" && ++reads === 2) {
        slack.failNext(method, { retryAfter: 1 });
      }
      return bot.call(method, run);
    },
  };
  const { reconcile } = createReconciliation(database, limited, { now });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "rate_limited",
    until: now() + 1_000,
  });
  expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0 });
  advance(999);
  expect(await reconcile(item.id)).toMatchObject({ kind: "waiting" });
  expect(slack.calls).toHaveLength(3);
  advance(1);
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(slack.calls[3]!.args.cursor).toBe(slack.calls[2]!.args.cursor);
});

test.each([
  ["team_access_not_granted", "channel_restricted"],
  ["channel_not_found", "channel_not_found"],
] as const)(
  "a %s read refusal suspends its channel but spends no pass or alternate read",
  async (error, reason) => {
    const { database, slack, item, now, advance, reconcile, read } = await setup();
    slack.failNext("conversations.replies", { error });
    expect(await reconcile(item.id)).toEqual({
      kind: "waiting",
      reason: error,
      until: null,
    });
    expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0, error });
    expect(await database.read((sql) => sql`SELECT status, status_reason FROM links`)).toEqual([
      { status: "suspended", status_reason: reason },
    ]);
    expect(slack.calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "conversations.replies",
    ]);
    expect(await database.read((sql) => readDueReconciliations(sql, now()))).toEqual([]);
    advance(86_400_000);
    expect(await reconcile(item.id)).toEqual({
      kind: "waiting",
      reason: "link_inactive",
      until: null,
    });
    expect(slack.calls).toHaveLength(2);
    await database.write((tx) => tx`UPDATE links SET status = 'active', status_reason = NULL`);
    expect(
      (await database.read((sql) => readDueReconciliations(sql, now()))).map((row) => row.id),
    ).toEqual([item.id]);
    const restarted = createReconciliation(
      database,
      createBotClient(database, slack.botToken, {
        slackApiUrl: slack.url,
        now,
      }),
      { now },
    );
    onTestFinished(() => restarted.close());
    expect(await restarted.reconcile(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
  },
);

test("an HTTP read failure remains unknown without spending a pass", async () => {
  const { slack, item, now, reconcile, read } = await setup();
  slack.failNext("conversations.replies", { status: 503 });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "HTTP 503",
    until: now() + 5_000,
  });
  expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0 });
});

test.each(["HTTP 503", "invalid_cursor", "lost response"])(
  "repeated %s failures back off without spending a pass",
  async (failure) => {
    const { slack, item, reconcile, now, advance, read } = await setup();
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
      slack.failNext(
        "conversations.replies",
        failure === "HTTP 503"
          ? { status: 503 }
          : failure === "invalid_cursor"
            ? { error: "invalid_cursor" }
            : { lostResponse: true },
      );
      expect(await reconcile(item.id)).toMatchObject({ kind: "waiting", until: now() + delay });
      expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0 });
      const count = slack.calls.length;
      advance(delay - 1);
      expect(await reconcile(item.id)).toMatchObject({ kind: "waiting", until: now() + 1 });
      expect(slack.calls).toHaveLength(count);
      advance(1);
    }
    expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  },
);

test("Retry-After may exceed the backoff cap and does not reset a failed pass's backoff", async () => {
  const { slack, item, reconcile, now, advance } = await setup();
  slack.failNext("conversations.replies", { status: 503 });
  await reconcile(item.id);
  advance(5_000);
  slack.failNext("conversations.replies", { retryAfter: 180 });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "rate_limited",
    until: now() + 180_000,
  });
  advance(179_999);
  expect(await reconcile(item.id)).toMatchObject({ kind: "waiting", until: now() + 1 });
  expect(slack.calls).toHaveLength(3);
  advance(1);
  slack.failNext("conversations.replies", { status: 503 });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "HTTP 503",
    until: now() + 10_000,
  });
});

test("a completed miss resets the next pass's failure backoff", async () => {
  const { slack, item, posted, reconcile, now, advance } = await setup();
  slack.failNext("conversations.replies", { status: 503 });
  await reconcile(item.id);
  advance(5_000);
  slack.deleteMessage("C-link", posted.ts);
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 1 },
  });
  advance(45_000);
  slack.failNext("conversations.replies", { status: 503 });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "HTTP 503",
    until: now() + 5_000,
  });
});

test("a resumed channel hold can complete a miss and keep the original deadline", async () => {
  const { database, slack, item, posted, reconcile, now } = await setup();
  slack.failNext("conversations.replies", { error: "not_in_channel" });
  await reconcile(item.id);
  slack.deleteMessage("C-link", posted.ts);
  await database.write((tx) => tx`UPDATE links SET status = 'active', status_reason = NULL`);
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 1, nextAttemptAt: now() + 50_000 },
  });
});

test("a refused linkless card stops automatic reads until manual resolution", async () => {
  const { database, slack, item, reconcile, now, advance, read } = await setup({ kind: "card" });
  await database.write((tx) => tx`UPDATE outbox SET link_id = NULL WHERE id = ${item.id}`);
  slack.failNext("conversations.history", { error: "channel_not_found" });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "channel_not_found",
    until: null,
  });
  expect(await read()).toMatchObject({
    state: "delivery_unknown",
    nextAttemptAt: null,
    reconcilePass: 0,
  });
  advance(86_400_000);
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "channel_unavailable",
    until: null,
  });
  expect(await database.read((sql) => readDueReconciliations(sql, now()))).toEqual([]);
  expect(slack.calls).toHaveLength(2);
});

test("a missing thread still finds its stray root without calling the read complete", async () => {
  const { slack, item, reconcile } = await setup({ misplaced: true });
  slack.failNext("conversations.replies", { error: "thread_not_found" });
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "stray", reconcilePass: 0 },
  });
  expect(slack.calls.at(-1)!.method).toBe("conversations.history");
});

test("a missing thread with no correlated root completes a miss without permitting another post", async () => {
  const { slack, item, reconcile, now, read } = await setup();
  slack.failNext("conversations.replies", { error: "thread_not_found" });
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 1, nextAttemptAt: now() + 50_000 },
  });
  expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 1 });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "conversations.replies",
    "conversations.history",
  ]);
});

test("a missing thread does not spend a pass until its root scan finishes", async () => {
  const { slack, item, posted, reconcile, now, advance, read } = await setup();
  slack.deleteMessage("C-link", posted.ts);
  slack.failNext("conversations.replies", { error: "thread_not_found" });
  slack.failNext("conversations.history", { status: 503 });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "HTTP 503",
    until: now() + 5_000,
  });
  expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0 });
  advance(5_000);
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 1 },
  });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "conversations.replies",
    "conversations.history",
    "conversations.history",
  ]);
});

test("a revoked token holds unknown delivery and prevents further reads", async () => {
  const { slack, item, reconcile, now, advance, read } = await setup();
  slack.failNext("conversations.replies", { error: "token_revoked" });
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "token_revoked",
    until: now() + 5_000,
  });
  advance(5_000);
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "installation_inactive",
    until: null,
  });
  expect(slack.calls).toHaveLength(2);
  expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0 });
});

test("an expired continuation restarts without spending its interrupted pass", async () => {
  const { database, slack, bot, item, now, advance, read } = await setup({ pageSize: 1 });
  let calls = 0;
  const limited: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    call(method, run) {
      if (method === "conversations.replies" && ++calls === 2) {
        slack.failNext(method, { retryAfter: 1 });
      }
      return bot.call(method, run);
    },
  };
  const service = createReconciliation(database, limited, { now });
  onTestFinished(() => service.close());
  await service.reconcile(item.id);
  advance(1_000);
  slack.failNext("conversations.replies", { error: "invalid_cursor" });
  expect(await service.reconcile(item.id)).toMatchObject({
    kind: "waiting",
    reason: "invalid_cursor",
  });
  expect(await read()).toMatchObject({ reconcilePass: 0, state: "delivery_unknown" });
  advance(5_000);
  expect(await service.reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(slack.calls[4]!.args).not.toHaveProperty("cursor");
});

test("restarting loses no pass and rereads from the start rather than trusting partial work", async () => {
  const { database, slack, bot, item, now, advance, read } = await setup({ pageSize: 1 });
  let calls = 0;
  const limited: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    call(method, run) {
      if (method === "conversations.replies" && ++calls === 2) {
        slack.failNext(method, { retryAfter: 1 });
      }
      return bot.call(method, run);
    },
  };
  const original = createReconciliation(database, limited, { now });
  await original.reconcile(item.id);
  await original.close();
  expect(await original.reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "closed",
    until: null,
  });
  advance(1_000);
  const restarted = createReconciliation(database, bot, { now });
  onTestFinished(() => restarted.close());
  expect(await read()).toMatchObject({ reconcilePass: 0 });
  expect(await restarted.reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(slack.calls[3]!.args).not.toHaveProperty("cursor");
});

test("concurrent callers share one read and one durable settlement", async () => {
  const { database, slack, bot, item, now } = await setup();
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
  const service = createReconciliation(database, held, { now });
  onTestFinished(() => service.close());
  const first = service.reconcile(item.id);
  await received.promise;
  const second = service.reconcile(item.id);
  const both = Promise.all([first, second]);
  try {
    expect(second).toBe(first);
  } finally {
    release.resolve();
    await both;
  }
  expect(await first).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(slack.calls).toHaveLength(2);
});

test.each(["missing_cursor", "repeated_cursor", "malformed_history_page"])(
  "an incomplete %s response neither spends a pass nor loops",
  async (reason) => {
    const { database, slack, bot, item, request, now, advance, read } = await setup({
      pageSize: 1,
    });
    slack.setMessage("C-link", {
      ts: "1700000101.000100",
      thread_ts: request.rootTs,
      user: "U-owner",
      text: "More context",
    });
    const malformed: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      call(method, run) {
        return bot.call(method, async (client) => {
          const original = client.conversations.replies;
          client.conversations.replies = async (args) => {
            const result = await original(args);
            if (reason === "malformed_history_page") return { ...result, messages: undefined };
            if (reason === "missing_cursor" || args.cursor) {
              return {
                ...result,
                response_metadata: {
                  ...result.response_metadata,
                  next_cursor: reason === "missing_cursor" ? undefined : args.cursor,
                },
              };
            }
            return result;
          };
          try {
            return await run(client);
          } finally {
            client.conversations.replies = original;
          }
        });
      },
    };
    const service = createReconciliation(database, malformed, { now });
    onTestFinished(() => service.close());
    expect(await service.reconcile(item.id)).toEqual({
      kind: "waiting",
      reason,
      until: now() + 5_000,
    });
    expect(await read()).toMatchObject({
      state: "delivery_unknown",
      reconcilePass: 0,
      error: reason,
    });
    expect(slack.calls).toHaveLength(reason === "repeated_cursor" ? 3 : 2);
    advance(5_000);
    for (const delay of [10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
      expect(await service.reconcile(item.id)).toEqual({
        kind: "waiting",
        reason,
        until: now() + delay,
      });
      expect(await read()).toMatchObject({ reconcilePass: 0, state: "delivery_unknown" });
      advance(delay);
    }
  },
);

test("closing during a partial read stops before the next page without spending a pass", async () => {
  const { database, slack, bot, item, now, read } = await setup({ pageSize: 1 });
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
  const service = createReconciliation(database, held, { now });
  const pending = service.reconcile(item.id);
  await received.promise;
  const closing = service.close();
  release.resolve();
  await closing;
  expect(await pending).toEqual({ kind: "waiting", reason: "closed", until: null });
  expect(await read()).toMatchObject({ state: "delivery_unknown", reconcilePass: 0 });
  expect(slack.calls).toHaveLength(2);
});

test("unexpected read failures propagate through the caller and shutdown", async () => {
  const { database, bot, item, now } = await setup();
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failed: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    async call() {
      received.resolve();
      await release.promise;
      throw new Error("Read worker failed");
    },
  };
  const service = createReconciliation(database, failed, { now });
  const pending = service.reconcile(item.id);
  await received.promise;
  const closing = service.close();
  const results = Promise.allSettled([pending, closing]);
  release.resolve();
  expect(await results).toEqual([
    { status: "rejected", reason: new Error("Read worker failed") },
    { status: "rejected", reason: new Error("Read worker failed") },
  ]);
  expect(await service.reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "closed",
    until: null,
  });
});

test("a legacy unknown edit without its target stops explicitly rather than guessing a message", async () => {
  const { database, slack, item, reconcile, read } = await setup();
  await database.write(
    (tx) => tx`UPDATE outbox SET attempt_method = 'chat.update' WHERE id = ${item.id}`,
  );
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "invalid_update_target",
    until: null,
  });
  expect(await read()).toMatchObject({
    state: "delivery_unknown",
    error: "invalid_update_target",
    nextAttemptAt: null,
    reconcilePass: 0,
  });
  expect(slack.calls).toHaveLength(1);
});

test.each([undefined, null, {}, { event_type: "other" }])(
  "exact text without exact metadata is never automatic delivery proof: %j",
  async (metadata) => {
    const { slack, item, posted, reconcile } = await setup();
    slack.setMessage("C-link", { ...posted, metadata });
    expect(await reconcile(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown", reconcilePass: 1 },
    });
  },
);

test("a manual resolution while a page is in flight cannot be overwritten by its proof", async () => {
  const { database, bot, item, now, read } = await setup();
  const resolved: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    async call(method, run) {
      const result = await bot.call(method, run);
      await database.write((tx) => tx`UPDATE outbox SET state = 'dropped' WHERE id = ${item.id}`);
      return result;
    },
  };
  expect(await createReconciliation(database, resolved, { now }).reconcile(item.id)).toEqual({
    kind: "changed",
  });
  expect(await read()).toMatchObject({ state: "dropped" });
});
import { gapOverlapMs } from "@activity/model/gaps";

import { expect, onTestFinished, test } from "bun:test";
import { gapOverlapMs } from "@activity/model/gaps";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { readApproval, staleApprovals } from "@links/server/approvals";
import { changeChannelId } from "@links/server/lifecycle";
import { createStoredApproval, createStoredLink } from "@links/server/testFixtures";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { compareTs, tsAt } from "@slackapi/model/ts";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import { outboxMetadata } from "../model/delivery";
import { renderMarkdown } from "../model/rendering";
import { settleRequestAnswer } from "./answers";
import {
  queueCard,
  queueItem,
  readDueReconciliations,
  readOutboxItem,
  readReadyOutbox,
  settleOutboxAttempt,
  startOutboxAttempt,
} from "./database";
import { createPostDelivery } from "./posts";
import { createReconciliation } from "./reconcile";
import { createRetraction } from "./retract";

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

test.each(["reply", "publication"] as const)(
  "a redacted orphan %s is forgotten after proof, without withdrawing its valid Slack post",
  async (kind) => {
    const { database, slack, item, posted, read, reconcile } = await setup({ kind });
    await database.write(async (tx) => {
      await tx`UPDATE outbox SET payload = '{"redacted":"unlink"}' WHERE id = ${item.id}`;
      await tx`DELETE FROM requests`;
      await tx`DELETE FROM links`;
    });
    expect(await reconcile(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", payload: { redacted: "unlink" }, payloadHash: item.payloadHash },
    });
    expect(await read()).toBeNull();
    expect(slack.getMessages("C-link").some((message) => message.ts === posted.ts)).toBe(true);
    expect(slack.calls.filter((call) => call.method === "chat.delete")).toEqual([]);
  },
);

test("a redacted orphan misplaced reply still gets withdrawn before both rows are forgotten", async () => {
  const { database, slack, bot, item, posted, now, read, reconcile } = await setup({
    misplaced: true,
  });
  await database.write(async (tx) => {
    await tx`UPDATE outbox SET payload = '{"redacted":"unlink"}' WHERE id = ${item.id}`;
    await tx`DELETE FROM requests`;
    await tx`DELETE FROM links`;
  });
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "stray" } });
  expect(await read()).toMatchObject({ state: "stray", payload: { redacted: "unlink" } });
  const cleanup = (await database.read((sql) => readReadyOutbox(sql, now()))).find(
    (row) => row.kind === "retract",
  );
  if (!cleanup) throw new Error("The stray needs withdrawal.");
  expect(await createRetraction(database, bot, { now }).retract(cleanup.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(await read()).toBeNull();
  expect(await database.read((sql) => readOutboxItem(sql, cleanup.id))).toBeNull();
  expect(slack.getMessages("C-link").some((message) => message.ts === posted.ts)).toBe(false);
});

test.each(["not_in_channel", "channel_not_found", "team_access_not_granted"])(
  "a channel-refused orphan is forgotten instead of waiting for a link to reactivate: %s",
  async (error) => {
    const { database, slack, item, read, reconcile } = await setup();
    await database.write((tx) => tx`DELETE FROM links`);
    slack.failNext("conversations.replies", { error });
    expect(await reconcile(item.id)).toEqual({ kind: "changed" });
    expect(await read()).toBeNull();
    const calls = slack.calls.length;
    expect(await reconcile(item.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(calls);
  },
);

test("unlink makes an already channel-held item due for local disposal without another read", async () => {
  const { database, slack, item, now, read, reconcile } = await setup();
  slack.failNext("conversations.replies", { error: "not_in_channel" });
  expect(await reconcile(item.id)).toMatchObject({
    kind: "waiting",
    reason: "not_in_channel",
    until: null,
  });
  await database.write((tx) => tx`DELETE FROM links`);
  expect(await database.read((sql) => readDueReconciliations(sql, now()))).toHaveLength(1);
  const calls = slack.calls.length;
  expect(await reconcile(item.id)).toEqual({ kind: "changed" });
  expect(await read()).toBeNull();
  expect(slack.calls).toHaveLength(calls);
});

test("a final empty pass forgets an orphan instead of retaining an unresolvable item", async () => {
  const { database, slack, item, posted, read, reconcile, advance } = await setup();
  slack.deleteMessage("C-link", posted.ts);
  await database.write((tx) => tx`DELETE FROM links`);
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { reconcilePass: 1 } });
  advance(50_000);
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { reconcilePass: 2 } });
  advance(60_000);
  expect(await reconcile(item.id)).toEqual({ kind: "changed" });
  expect(await read()).toBeNull();
  expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test.each([
  { reconcile_pass: 3, next_attempt_at: null },
  { error: "invalid_update_target", next_attempt_at: null },
])("an orphan that stopped before unlink is locally discarded: %j", async (changes) => {
  const { database, slack, item, now, read, reconcile } = await setup();
  await database.write(async (tx) => {
    await tx`UPDATE outbox SET ${tx(changes)} WHERE id = ${item.id}`;
    await tx`DELETE FROM links`;
  });
  expect(await database.read((sql) => readDueReconciliations(sql, now()))).toHaveLength(1);
  const calls = slack.calls.length;
  expect(await reconcile(item.id)).toEqual({ kind: "changed" });
  expect(await read()).toBeNull();
  expect(slack.calls).toHaveLength(calls);
});

test("a redacted old-message edit keeps its target ts and can be proved after unlink", async () => {
  const { database, bot, item, posted, now, advance, reconcile } = await setup();
  await reconcile(item.id);
  const rendered = renderMarkdown("Progress");
  if (rendered.kind !== "rendered") throw new Error("The edit needs rendered output.");
  const { text, blocks, parse } = rendered.message;
  const payload = { text, blocks, parse, ts: posted.ts };
  const queued = await database.write((tx) =>
    queueItem(
      tx,
      {
        kind: "progress",
        linkId: "link",
        channelId: "C-link",
        threadTs: item.threadTs,
        payload,
      },
      now(),
    ),
  );
  const sending = await database.write(async (tx) => {
    const row = await readOutboxItem(tx, queued.id);
    if (!row) throw new Error("The edit disappeared.");
    const result = await startOutboxAttempt(tx, row, payload, "chat.update", now());
    if (result.kind !== "started") throw new Error("The edit should start.");
    return result.item;
  });
  await bot.call("chat.update", (client) =>
    client.chat.update({
      channel: sending.channelId,
      ...payload,
      metadata: outboxMetadata(sending),
    }),
  );
  await database.write(async (tx) => {
    await settleOutboxAttempt(
      tx,
      sending,
      {
        state: "delivery_unknown",
        nextAttemptAt: now() + 10_000,
        error: "interrupted",
      },
      now(),
    );
    await tx`UPDATE outbox SET payload = ${JSON.stringify({ redacted: "unlink", ts: posted.ts })}
      WHERE id = ${queued.id}`;
    await tx`DELETE FROM links`;
  });
  advance(10_000);
  expect(await reconcile(queued.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", slackTs: posted.ts, evidence: "metadata" },
  });
  expect(await database.read((sql) => readOutboxItem(sql, queued.id))).toBeNull();
});

test("an unlinked unknown card post survives until its stale update can follow proved delivery", async () => {
  const { database, slack, item, approval, delivery, now, read, reconcile } = await setup({
    kind: "card",
  });
  if (!approval) throw new Error("The fixture needs an approval.");
  await database.write(async (tx) => {
    await staleApprovals(tx, [approval], "link_changed", now());
    await tx`DELETE FROM links`;
  });
  const update = (await database.read((sql) => readReadyOutbox(sql, now()))).find(
    (row) => row.kind === "card" && row.phase === "update",
  );
  if (!update) throw new Error("The card needs its stale update.");
  expect(await delivery.updateCard(update.id)).toMatchObject({
    kind: "waiting",
    reason: "card_not_posted",
  });
  expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(await read()).not.toBeNull();
  expect(await delivery.updateCard(update.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(await database.read((sql) => sql`SELECT id FROM outbox WHERE link_id = 'link'`)).toEqual(
    [],
  );
  expect(await database.read((sql) => readApproval(sql, approval.id))).toBeNull();
  const card = slack.getMessages("C-link").find((message) => message.bot_id === "B-bot");
  expect(card?.blocks).not.toContainEqual(expect.objectContaining({ type: "actions" }));
});

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
  for (const call of reads.slice(1)) {
    expect(call.args).toMatchObject({ oldest: reads[0]!.args.oldest, cursor: expect.any(String) });
  }
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

test("a lost reply response correlated at root cancels its request before withdrawal", async () => {
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
    state: "cancelled",
    closedReason: "thread_gone",
    attention: null,
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
  const { database, slack, item, now, reconcile, read } = await setup();
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
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "reconciliation_stopped",
    until: null,
  });
  expect(await database.read((sql) => readDueReconciliations(sql, now() + 86_400_000))).toEqual([]);
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

test("an exhausted read that was once held for its channel never reads again", async () => {
  const { database, slack, item, posted, reconcile, advance } = await setup();
  slack.deleteMessage("C-link", posted.ts);
  await reconcile(item.id);
  advance(50_000);
  await reconcile(item.id);
  advance(60_000);
  slack.failNext("conversations.replies", { error: "not_in_channel" });
  expect(await reconcile(item.id)).toMatchObject({ reason: "not_in_channel", until: null });
  await database.write((tx) => tx`UPDATE links SET status = 'active', status_reason = NULL`);
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 3, nextAttemptAt: null },
  });
  const count = slack.calls.length;
  expect(await reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "reconciliation_stopped",
    until: null,
  });
  expect(slack.calls).toHaveLength(count);
});

test("a read whose channel moved starts over from its first page with a fresh backoff", async () => {
  const { database, slack, bot, item, now, advance } = await setup({ pageSize: 1 });
  let reads = 0;
  const failing: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    call(method, run) {
      if (method === "conversations.replies" && ++reads >= 2) {
        slack.failNext(method, { status: 503 });
      }
      return bot.call(method, run);
    },
  };
  const service = createReconciliation(database, failing, { now });
  onTestFinished(() => service.close());
  expect(await service.reconcile(item.id)).toMatchObject({ until: now() + 5_000 });
  advance(5_000);
  expect(await service.reconcile(item.id)).toMatchObject({ until: now() + 10_000 });
  expect(slack.calls.at(-1)!.args).toHaveProperty("cursor");
  slack.addChannel({ id: "C-moved", is_private: true, members: ["U-owner", "U-bot"] });
  await database.write((tx) => changeChannelId(tx, "C-link", "C-moved", now()));
  advance(10_000);
  expect(await service.reconcile(item.id)).toEqual({
    kind: "waiting",
    reason: "HTTP 503",
    until: now() + 5_000,
  });
  expect(slack.calls.at(-1)!.args).toMatchObject({ channel: "C-moved" });
  expect(slack.calls.at(-1)!.args).not.toHaveProperty("cursor");
});

test("a read whose channel moves between pages stops before reading the old channel again", async () => {
  const { database, slack, bot, item, now, read } = await setup({ pageSize: 1 });
  slack.addChannel({ id: "C-moved", is_private: true, members: ["U-owner", "U-bot"] });
  let moved = false;
  const moving: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    async call(method, run) {
      const result = await bot.call(method, run);
      if (!moved) {
        moved = true;
        await database.write((tx) => changeChannelId(tx, "C-link", "C-moved", now()));
      }
      return result;
    },
  };
  const service = createReconciliation(database, moving, { now });
  onTestFinished(() => service.close());
  expect(await service.reconcile(item.id)).toEqual({ kind: "changed" });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "conversations.replies",
  ]);
  expect(await read()).toMatchObject({
    state: "delivery_unknown",
    channelId: "C-moved",
    reconcilePass: 0,
  });
});

test.each(["sent", "stray"] as const)(
  "an item that settled as %s is never read for again",
  async (state) => {
    const { slack, item, advance, reconcile } = await setup({ misplaced: state === "stray" });
    expect(await reconcile(item.id)).toMatchObject({ kind: "settled", item: { state } });
    advance(120_000);
    const count = slack.calls.length;
    expect(await reconcile(item.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(count);
  },
);

test("an edit whose thread is gone spends its pass rather than retrying the thread", async () => {
  const { database, slack, item, posted, reconcile } = await setup();
  await database.write(
    (tx) => tx`
      UPDATE outbox SET attempt_method = 'chat.update', payload = json_set(payload, '$.ts', ${posted.ts})
      WHERE id = ${item.id}
    `,
  );
  slack.failNext("conversations.replies", { error: "thread_not_found" });
  expect(await reconcile(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "delivery_unknown", reconcilePass: 1 },
  });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "conversations.replies",
  ]);
});

test("a channel hold stays held when its link is suspended again as it resumes", async () => {
  const { database, slack, bot, item, now, reconcile, read } = await setup();
  slack.failNext("conversations.replies", { error: "not_in_channel" });
  await reconcile(item.id);
  await database.write((tx) => tx`UPDATE links SET status = 'active', status_reason = NULL`);
  // Resume is the second write, after prepare saw the link active.
  const racing: BridgeDatabase = Object.create(database);
  let writes = 0;
  racing.write = async (operation) => {
    if (++writes === 2) {
      await database.write(
        (tx) => tx`UPDATE links SET status = 'suspended', status_reason = 'bot_removed'`,
      );
    }
    return database.write(operation);
  };
  const service = createReconciliation(racing, bot, { now });
  onTestFinished(() => service.close());
  expect(await service.reconcile(item.id)).toEqual({ kind: "changed" });
  expect(await read()).toMatchObject({ error: "not_in_channel", nextAttemptAt: null });
  expect(slack.calls).toHaveLength(2);
});

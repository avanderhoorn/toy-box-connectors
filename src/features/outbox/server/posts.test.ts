import { describe, expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { APPROVE_ACTION_ID } from "@links/model/approvals";
import { privateAudience } from "@links/model/testFixtures";
import { readApproval, staleApprovals, takeClick } from "@links/server/approvals";
import { readApprovalCard } from "@links/server/cards";
import { createStoredApproval, createStoredLink } from "@links/server/testFixtures";
import { confirmAnswer, reviseRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { channelFacts, slackPerson } from "@slackapi/model/testFixtures";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import {
  invalidateChannelInfo,
  readChannelInfo,
  writeChannelInfo,
} from "@slackapi/server/channels";
import { markAuthFailed, readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { writeSlackPerson } from "@slackapi/server/users";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import { renderMarkdown } from "../model/rendering";
import { settleRequestAnswer } from "./answers";
import {
  queueCard,
  queueItem,
  readOutboxItem,
  readReadyOutbox,
  readDueReconciliations,
  startOutboxAttempt,
  type NewOutboxItem,
} from "./database";
import { createPostDelivery } from "./posts";

async function setup({ fresh = true, requesterUserId = "U-owner", timeoutMs = 1_000 } = {}) {
  let at = 1_700_000_200_000;
  const now = () => at;
  const database = await openTestDatabase();
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  onTestFinished(() => slack.stop());
  slack.addChannel({
    id: "C-link",
    is_private: true,
    context_team_id: "T-home",
    shared_team_ids: ["T-home"],
    members: ["U-owner", "U-bot"],
  });
  await createStoredInstallation(database);
  await createStoredLink(database);
  const request = await createStoredRequest(database, {
    requesterUserId,
    state: "answering",
    servedRev: 1,
    seenAt: at - 10_000,
    touchedAt: at - 10_000,
  });
  slack.setMessage("C-link", {
    type: "message",
    ts: request.sourceTs,
    user: requesterUserId,
    text: "Question",
  });
  if (fresh) await database.write((tx) => writeChannelInfo(tx, channelFacts(), now()));
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs,
    now,
  });
  const delivery = createPostDelivery(database, bot, { now });
  async function queue(changes: Partial<NewOutboxItem> = {}) {
    const rendered = renderMarkdown("A **safe answer** with [docs](https://example.com).");
    if (rendered.kind !== "rendered") throw new Error("The fixture needs rendered output.");
    return database.write((tx) =>
      queueItem(
        tx,
        {
          kind: "reply",
          phase: "final",
          linkId: "link",
          requestId: request.id,
          requestRev: 1,
          channelId: "C-link",
          threadTs: request.rootTs,
          payload: { ...rendered.message },
          ...changes,
        },
        now(),
      ),
    );
  }
  const read = (id: string) => database.read((sql) => readOutboxItem(sql, id));
  const readRequestState = () => database.read((sql) => readRequest(sql, request.id));
  return {
    database,
    slack,
    bot,
    delivery,
    queue,
    read,
    request,
    readRequestState,
    now,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

async function postedCard(timeoutMs = 1_000) {
  const fixture = await setup({ fresh: false, timeoutMs });
  const { database, delivery, now } = fixture;
  const approval = await createStoredApproval(database, {
    card: { channelId: "C-link", ts: null },
    createdAt: now(),
    expiresAt: now() + 3_600_000,
  });
  const target = { approvalId: approval.id, linkId: "link", channelId: "C-link" };
  await database.write((tx) => queueCard(tx, { ...target, phase: "post" }, now()));
  const post = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
  expect(await delivery.post(post.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  const current = await database.read((sql) => readApproval(sql, approval.id));
  if (!current) throw new Error("The fixture card needs its approval.");
  const latestUpdate = async () => {
    const item = (await database.read((sql) => readReadyOutbox(sql, now()))).find(
      (item) => item.approvalId === approval.id && item.phase === "update",
    );
    if (!item) throw new Error("The fixture needs a queued card update.");
    return item;
  };
  const queueUpdate = async () => {
    await database.write((tx) => queueCard(tx, { ...target, phase: "update" }, now()));
    return latestUpdate();
  };
  return { ...fixture, approval: current, latestUpdate, queueUpdate };
}

async function decidedCard(timeoutMs = 1_000) {
  const fixture = await postedCard(timeoutMs);
  const { database, approval, now } = fixture;
  await database.write((tx) =>
    takeClick(
      tx,
      {
        type: "block_actions",
        api_app_id: "A-app",
        team: { id: "T-home" },
        user: { id: "U-owner" },
        trigger_id: "1.2.3",
        container: {
          type: "message",
          message_ts: approval.card.ts,
          channel_id: approval.card.channelId,
          is_ephemeral: false,
        },
        actions: [
          {
            type: "button",
            action_id: APPROVE_ACTION_ID,
            block_id: "decide",
            value: approval.id,
            action_ts: "1700000200.000200",
          },
        ],
      },
      now(),
    ),
  );
  const decided = await database.read((sql) => readApproval(sql, approval.id));
  expect(decided).toMatchObject({ state: "approved" });
  return { ...fixture, approval: decided! };
}

describe("confirmed posts", () => {
  test("the SDK sees committed sending, the frozen body and matching metadata before posting once", async () => {
    const fixture = await setup();
    const { database, bot, slack, queue, read, request, readRequestState, now } = fixture;
    const queued = await queue();
    const original = await read(queued.id);
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      call(method, run) {
        return bot.call(method, async (client) => {
          expect(await read(queued.id)).toMatchObject({
            state: "sending",
            attempts: 1,
            attemptMethod: "chat.postMessage",
            attemptStartedAt: now(),
            payload: original!.payload,
            payloadHash: original!.payloadHash,
          });
          return run(client);
        });
      },
    };
    const delivery = createPostDelivery(database, checked, { now });

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", evidence: "response", metadataOk: true },
    });
    expect(await readRequestState()).toMatchObject({ state: "answered" });
    const [call] = slack.calls;
    expect(call!.method).toBe("chat.postMessage");
    expect(call!.args).toMatchObject({
      ...original!.payload,
      blocks: JSON.stringify(original!.payload.blocks),
      mrkdwn: "false",
      unfurl_links: "false",
      unfurl_media: "false",
      channel: "C-link",
      thread_ts: request.rootTs,
      reply_broadcast: "false",
      metadata: JSON.stringify({
        event_type: "toy_box_outbox",
        event_payload: { id: queued.id, payload_hash: original!.payloadHash },
      }),
    });
    expect((await read(queued.id))!.payload).not.toHaveProperty("metadata");
    expect(
      await database.read((sql) => sql`SELECT kind FROM outbox WHERE kind = 'reaction'`),
    ).toHaveLength(2);
    expect(await delivery.post(queued.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(1);
  });

  test("a publication uses its current publish destination and no thread", async () => {
    const { database, slack, queue, delivery, now } = await setup();
    slack.addChannel({ id: "C-publish", is_private: true });
    await database.write(async (tx) => {
      await tx`UPDATE links SET publish_channel_id = 'C-publish',
        approved_audience = ${JSON.stringify({ monitored: privateAudience("C-link"), publish: privateAudience("C-publish") })}`;
      await writeChannelInfo(tx, channelFacts({ id: "C-publish" }), now());
    });
    const queued = await queue({
      kind: "publication",
      phase: null,
      channelId: "C-publish",
      threadTs: null,
      requestId: null,
      requestRev: null,
      publicationKey: "notes/2026-W43",
    });

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(slack.calls[0]!.args.channel).toBe("C-publish");
    expect(slack.calls[0]!.args).not.toHaveProperty("thread_ts");
    expect(
      await database.read((sql) => sql`SELECT kind FROM outbox WHERE kind = 'reaction'`),
    ).toEqual([]);
  });

  test("an explicit follow-up posts without reopening a terminal request", async () => {
    const { database, queue, delivery, request, now, readRequestState } = await setup();
    await database.write((tx) => saveRequest(tx, confirmAnswer(request, 1, now())));
    const before = await readRequestState();
    const queued = await queue({ phase: "follow_up" });

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(await readRequestState()).toEqual(before);
  });

  test("a successful write without metadata is sent, never blindly retried", async () => {
    const { slack, queue, delivery, readRequestState } = await setup();
    slack.failNext("chat.postMessage", { dropMetadata: true });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", metadataOk: false, evidence: "response" },
    });
    expect(await readRequestState()).toMatchObject({ state: "answered" });
    expect(await delivery.post(queued.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(1);
  });

  test("an accepted but unproved post is due ten seconds after its attempt, not its late receipt", async () => {
    const { database, bot, slack, queue, read, now, advance } = await setup();
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      call(method, run) {
        return bot.call(method, async (client) => {
          const original = client.chat.postMessage;
          client.chat.postMessage = async (args) => ({
            ...(await original(args)),
            message: undefined,
          });
          try {
            const result = await run(client);
            advance(2_500);
            return result;
          } finally {
            client.chat.postMessage = original;
          }
        });
      },
    };
    const item = await queue();
    const attemptAt = now();
    expect(await createPostDelivery(database, checked, { now }).post(item.id)).toMatchObject({
      kind: "settled",
      item: {
        state: "delivery_unknown",
        error: "invalid_response",
        nextAttemptAt: attemptAt + 10_000,
      },
    });
    expect(await database.read((sql) => readDueReconciliations(sql, attemptAt + 9_999))).toEqual(
      [],
    );
    expect(
      (await database.read((sql) => readDueReconciliations(sql, attemptAt + 10_000))).map(
        (item) => item.id,
      ),
    ).toEqual([item.id]);
    expect(await read(item.id)).toMatchObject({ attemptStartedAt: attemptAt });
    expect(slack.getMessages("C-link")).toHaveLength(2);
  });
});

describe("send-time authority", () => {
  test("a missing cache is read through the shared client before the send is prepared", async () => {
    const { database, slack, queue, delivery, now } = await setup({ fresh: false });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attemptStartedAt: now() },
    });
    expect(slack.calls.map((call) => call.method)).toEqual([
      "conversations.info",
      "chat.postMessage",
    ]);
    expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toMatchObject({
      refreshedAt: now(),
      invalidatedAt: null,
    });
  });

  test("an old revision is superseded and returns the request as updated without a call", async () => {
    const { database, queue, delivery, request, now, readRequestState, slack } = await setup();
    const queued = await queue();
    await database.write((tx) => saveRequest(tx, reviseRequest(request, "new-input", now())));

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "superseded", attempts: 0 },
    });
    expect(await readRequestState()).toMatchObject({ state: "in_progress", attention: "updated" });
    expect(slack.calls).toEqual([]);
  });

  test("fresh cached public facts cannot overrule the owner's narrowed approved audience", async () => {
    const { database, queue, delivery, now, slack } = await setup();
    const audience = privateAudience("C-link");
    await database.write(async (tx) => {
      await writeChannelInfo(tx, channelFacts({ kind: "public" }), now());
      await tx`UPDATE links SET approved_audience = ${JSON.stringify({
        monitored: { ...audience, kind: "public" },
        publish: { ...audience, kind: "public" },
      })}`;
    });
    const queued = await queue();
    await database.write(
      (tx) =>
        tx`UPDATE links SET approved_audience = ${JSON.stringify({ monitored: audience, publish: audience })}`,
    );

    expect(await delivery.post(queued.id)).toEqual({
      kind: "waiting",
      reason: "channel_made_public",
      until: null,
    });
    expect(await database.read((sql) => sql`SELECT status, status_reason FROM links`)).toEqual([
      { status: "suspended", status_reason: "channel_made_public" },
    ]);
    expect(slack.calls).toEqual([]);
  });

  test.each([
    ["channel_not_found", "channel_not_found"],
    ["team_access_not_granted", "channel_restricted"],
  ] as const)(
    "a refresh refused with %s suspends every use of its channel",
    async (error, reason) => {
      const { database, slack, queue, delivery, now } = await setup({ fresh: false });
      await createStoredLink(database, "two", { publish_channel_id: "C-link" });
      await createStoredLink(database, "three");
      slack.failNext("conversations.info", { error });
      const queued = await queue();

      expect(await delivery.post(queued.id)).toEqual(
        error === "channel_not_found"
          ? { kind: "waiting", reason: "link_inactive", until: null }
          : { kind: "waiting", reason: error, until: now() + 5_000 },
      );
      expect(
        await database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`),
      ).toEqual([
        { id: "link", status: "suspended", status_reason: reason },
        { id: "three", status: "active", status_reason: null },
        { id: "two", status: "suspended", status_reason: reason },
      ]);
      expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
    },
  );

  test("an unverified source waits without taking a slot or making a call", async () => {
    const { database, queue, delivery, request, now, slack } = await setup();
    const queued = await queue();
    await database.write((tx) => saveRequest(tx, { ...request, sourceUnverifiedAt: now() }));

    expect(await delivery.post(queued.id)).toEqual({
      kind: "waiting",
      reason: "source_unverified",
      until: null,
    });
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
    expect(slack.calls).toEqual([]);
  });

  test("a requester no longer allowed is cancelled before any call", async () => {
    const { queue, delivery, readRequestState, slack } = await setup({
      requesterUserId: "U-stranger",
    });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "cancelled", attempts: 0 },
    });
    expect(await readRequestState()).toMatchObject({
      state: "cancelled",
      closedReason: "requester_denied",
    });
    expect(slack.calls).toEqual([]);
  });

  test("a channel read cannot outrun a pause that commits before the post", async () => {
    const { database, bot, queue, now, slack } = await setup({ fresh: false });
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      async call(method, run) {
        const result = await bot.call(method, run);
        if (method === "conversations.info") {
          await database.write((tx) => tx`UPDATE links SET status = 'paused'`);
        }
        return result;
      },
    };
    const queued = await queue();

    expect(await createPostDelivery(database, checked, { now }).post(queued.id)).toEqual({
      kind: "waiting",
      reason: "link_inactive",
      until: null,
    });
    expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
  });

  test("malformed channel facts stay queued with an explicit read failure, not a post attempt", async () => {
    const { slack, queue, delivery, read, now } = await setup({ fresh: false });
    slack.setChannel({ id: "C-link" });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toEqual({
      kind: "waiting",
      reason: "malformed_channel_info",
      until: now() + 5_000,
    });

    expect(await read(queued.id)).toMatchObject({
      state: "queued",
      attempts: 0,
      error: "malformed_channel_info",
    });
    expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
  });

  test("a mismatched channel read writes and judges nothing", async () => {
    const { database, bot, slack, queue, now } = await setup({ fresh: false });
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      call(method, run) {
        return bot.call(method, async (client) => {
          const original = client.conversations.info;
          client.conversations.info = async (args) => {
            const result = await original(args);
            if (!result.channel) throw new Error("The fixture needs channel facts.");
            return { ...result, channel: { ...result.channel, id: "C-other" } };
          };
          try {
            return await run(client);
          } finally {
            client.conversations.info = original;
          }
        });
      },
    };
    const item = await queue();
    expect(await createPostDelivery(database, checked, { now }).post(item.id)).toEqual({
      kind: "waiting",
      reason: "mismatched_channel_info",
      until: now() + 5_000,
    });
    expect(await database.read((sql) => sql`SELECT * FROM channel_info`)).toEqual([]);
    expect(await database.read((sql) => sql`SELECT status FROM links`)).toEqual([
      { status: "active" },
    ]);
    expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
  });

  test("a held channel read uses its Retry-After rather than a shorter generic delay", async () => {
    const { slack, queue, delivery, now, read } = await setup({ fresh: false });
    slack.failNext("conversations.info", { retryAfter: 10 });
    const item = await queue();
    expect(await delivery.post(item.id)).toEqual({
      kind: "waiting",
      reason: "rate_limited",
      until: now() + 10_000,
    });
    expect(await read(item.id)).toMatchObject({ state: "queued", nextAttemptAt: now() + 10_000 });
    expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
  });

  test("an invalidation during a channel read stops the post instead of trusting the late answer", async () => {
    const { database, bot, queue, now, advance, slack } = await setup();
    advance(120_000);
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      async call(method, run) {
        const result = await bot.call(method, run);
        advance(1);
        await database.write((tx) => invalidateChannelInfo(tx, "C-link", now()));
        return result;
      },
    };
    const queued = await queue();

    expect(await createPostDelivery(database, checked, { now }).post(queued.id)).toEqual({
      kind: "waiting",
      reason: "channel_info_invalidated",
      until: now() + 1_000,
    });
    expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
  });

  test("secret-bearing or unsafe stored snapshots fail without leaving the bridge", async () => {
    const { queue, delivery, readRequestState, slack } = await setup();
    const rendered = renderMarkdown("A safe snapshot before it is corrupted.");
    if (rendered.kind !== "rendered") throw new Error("The fixture needs rendered output.");
    const queued = await queue({
      payload: { ...rendered.message, text: "xoxb-fake-never-send" },
    });

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error: "slack_token", attempts: 0 },
    });
    expect(await readRequestState()).toMatchObject({
      state: "in_progress",
      attention: "reply_failed",
    });
    expect(slack.calls).toEqual([]);
  });
});

describe("uncertain and rejected writes", () => {
  test("a misplaced reply is durably stray and queues withdrawal without answering", async () => {
    const { database, slack, queue, delivery, readRequestState } = await setup();
    slack.failNext("chat.postMessage", { misplacedReply: true });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "stray", error: "wrong_thread", evidence: "response" },
    });
    expect(await readRequestState()).toMatchObject({ state: "answering" });
    const cleanup = await database.read(
      (sql) => sql`SELECT kind, state, payload FROM outbox WHERE kind <> 'reply'`,
    );
    expect(cleanup).toEqual([
      { kind: "retract", state: "queued", payload: JSON.stringify({ target: queued.id }) },
    ]);
    expect(slack.getMessages("C-link")[1]).not.toHaveProperty("thread_ts");
    expect(await delivery.post(queued.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(1);
  });

  test("a 429 retries the same body only at its exact deadline", async () => {
    const { slack, queue, delivery, read, now, advance } = await setup();
    slack.failNext("chat.postMessage", { retryAfter: 1 });
    const queued = await queue();
    const original = await read(queued.id);

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued", nextAttemptAt: now() + 1_000 },
    });

    advance(999);
    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "waiting",
      reason: "rate_limited",
    });
    expect(slack.calls).toHaveLength(1);
    advance(1);
    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attempts: 2 },
    });
    expect((await read(queued.id))!.payloadHash).toBe(original!.payloadHash);
    expect(slack.calls[1]!.args).toEqual(slack.calls[0]!.args);
  });

  test("a shorter shared cooldown never shortens an item's longer wait", async () => {
    const { database, slack, queue, delivery, read, now } = await setup();
    slack.failNext("chat.postMessage", { retryAfter: 1 });
    const item = await queue();
    await delivery.post(item.id);
    await database.write(
      (tx) => tx`UPDATE outbox SET next_attempt_at = ${now() + 5_000} WHERE id = ${item.id}`,
    );
    expect(await delivery.post(item.id)).toEqual({
      kind: "waiting",
      reason: "rate_limited",
      until: now() + 5_000,
    });
    expect(await read(item.id)).toMatchObject({ nextAttemptAt: now() + 5_000 });
    expect(slack.calls).toHaveLength(1);
  });

  test("a lost response never sends an unknown message again", async () => {
    const { database, bot, slack, queue, read, readRequestState, advance, now } = await setup({
      timeoutMs: 40,
    });
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      async call(method, run) {
        const result = await bot.call(method, run);
        advance(2_500);
        return result;
      },
    };
    const delivery = createPostDelivery(database, checked, { now });
    slack.failNext("chat.postMessage", { lostResponse: true });
    const queued = await queue();
    const attemptAt = now();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: {
        state: "delivery_unknown",
        attempts: 1,
        attemptStartedAt: attemptAt,
        nextAttemptAt: attemptAt + 10_000,
      },
    });
    advance(120_000);
    expect(await delivery.post(queued.id)).toEqual({ kind: "changed" });
    expect((await read(queued.id))!.state).toBe("delivery_unknown");
    expect(await readRequestState()).toMatchObject({ state: "answering" });
    expect(slack.getMessages("C-link")).toHaveLength(2);
    expect(slack.calls).toHaveLength(1);
  });

  test.each(["internal_error", "fatal_error", "service_unavailable"])(
    "an accepted write followed by %s is unknown, not a safe retry",
    async (error) => {
      const { slack, queue, delivery, readRequestState, now } = await setup();
      slack.failNext("chat.postMessage", { error, afterWrite: true });
      const queued = await queue();

      expect(await delivery.post(queued.id)).toMatchObject({
        kind: "settled",
        item: { state: "delivery_unknown", error, nextAttemptAt: now() + 10_000 },
      });
      expect(await readRequestState()).toMatchObject({ state: "answering" });
      expect(slack.getMessages("C-link")).toHaveLength(2);
    },
  );

  test("a thread-local refusal returns the request as failed without suspending its link", async () => {
    const { database, slack, queue, delivery, readRequestState } = await setup();
    slack.failNext("chat.postMessage", { error: "thread_not_found" });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error: "thread_not_found" },
    });
    expect(await readRequestState()).toMatchObject({
      state: "in_progress",
      attention: "reply_failed",
    });
    expect(await database.read((sql) => sql`SELECT status FROM links`)).toEqual([
      { status: "active" },
    ]);
  });

  test("a channel-wide refusal suspends all its links, not unrelated links", async () => {
    const { database, slack, queue, delivery, now } = await setup();
    await createStoredLink(database, "two", { publish_channel_id: "C-link" });
    await createStoredLink(database, "three");
    slack.failNext("chat.postMessage", { error: "not_in_channel" });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed" },
    });
    expect(
      await database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`),
    ).toEqual([
      { id: "link", status: "suspended", status_reason: "bot_removed" },
      { id: "three", status: "active", status_reason: null },
      { id: "two", status: "suspended", status_reason: "bot_removed" },
    ]);
    expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toMatchObject({
      invalidatedAt: now(),
    });
  });

  test("an expired token holds the frozen item and installation instead of failing the request", async () => {
    const { database, slack, queue, delivery, readRequestState } = await setup();
    slack.failNext("chat.postMessage", { error: "token_expired" });
    const queued = await queue();

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued", error: "token_expired" },
    });
    expect(await database.read(readInstallation)).toMatchObject({ status: "auth_failed" });
    expect(await readRequestState()).toMatchObject({ state: "answering" });
    expect(await delivery.post(queued.id)).toEqual({
      kind: "waiting",
      reason: "installation_inactive",
      until: null,
    });
    expect(slack.calls).toHaveLength(1);
  });
});

test("a gap noticed during the SDK call holds confirmation until the source is verified", async () => {
  const { database, bot, queue, request, now, readRequestState } = await setup();
  const checked: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    call(method, run) {
      return bot.call(method, async (client) => {
        const result = await run(client);
        await database.write((tx) => saveRequest(tx, { ...request, sourceUnverifiedAt: now() }));
        return result;
      });
    },
  };
  const queued = await queue();

  expect(await createPostDelivery(database, checked, { now }).post(queued.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", evidence: "response" },
  });
  expect(await readRequestState()).toMatchObject({ state: "answering", sourceUnverifiedAt: now() });
  expect(
    await database.read((sql) => sql`SELECT kind FROM outbox WHERE kind = 'reaction'`),
  ).toEqual([]);
  await database.write(async (tx) => {
    await saveRequest(tx, { ...request, sourceUnverifiedAt: null });
    await settleRequestAnswer(tx, request.id, now());
  });
  expect(await readRequestState()).toMatchObject({ state: "answered" });
});

describe("approval card updates", () => {
  test("an edit carries current blocks and parse none, without post-only flags or a post slot", async () => {
    const { database, slack, delivery, queueUpdate, approval, now, read } = await decidedCard();
    const slots = await database.read((sql) => sql`SELECT * FROM outbox_channels`);
    await database.write((tx) => staleApprovals(tx, [approval], "link_changed", now()));
    const item = await queueUpdate();
    const expected = await database.read((sql) => readApprovalCard(sql, approval.id));

    expect(await delivery.updateCard(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attemptMethod: "chat.update", slackTs: approval.card.ts },
    });
    expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.update"]);
    expect(slack.calls[1]!.args).toMatchObject({
      channel: "C-link",
      ts: approval.card.ts,
      text: expected!.message.text,
      blocks: JSON.stringify(expected!.message.blocks),
      parse: "none",
    });
    expect((await read(item.id))!.payload).toEqual({
      text: expected!.message.text,
      blocks: expected!.message.blocks,
      parse: "none",
      ts: approval.card.ts,
    });
    expect(slack.calls[1]!.args.metadata).toBe(
      JSON.stringify({
        event_type: "toy_box_outbox",
        event_payload: { id: item.id, payload_hash: (await read(item.id))!.payloadHash },
      }),
    );
    for (const flag of ["mrkdwn", "unfurl_links", "unfurl_media", "thread_ts", "reply_broadcast"]) {
      expect(slack.calls[1]!.args).not.toHaveProperty(flag);
    }
    expect(
      slack.getMessages("C-link").find((message) => message.ts === approval.card.ts)!.blocks,
    ).toEqual(expected!.message.blocks);
    expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual(slots);
  });

  test("a rejected edit rereads names and snapshots its fresh body at the retry deadline", async () => {
    const { database, slack, delivery, queueUpdate, now, advance, read } = await decidedCard();
    const item = await queueUpdate();
    slack.failNext("chat.update", { retryAfter: 1 });
    expect(await delivery.updateCard(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued", attempts: 1 },
    });
    const original = await read(item.id);
    await database.write((tx) =>
      writeSlackPerson(tx, slackPerson({ id: "U-carol", realName: "Carol Current" }), now()),
    );
    advance(999);
    expect(await delivery.updateCard(item.id)).toMatchObject({
      kind: "waiting",
      reason: "rate_limited",
    });
    expect(slack.calls).toHaveLength(2);
    advance(1);

    expect(await delivery.updateCard(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attempts: 2 },
    });
    expect(slack.calls[2]!.args.blocks).toContain("Carol Current");
    expect((await read(item.id))!.payloadHash).not.toBe(original!.payloadHash);
  });

  test("a card update waits while its initial post has unknown delivery", async () => {
    const { database, slack, delivery, now } = await setup({ timeoutMs: 40 });
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
      createdAt: now(),
      expiresAt: now() + 3_600_000,
    });
    await database.write((tx) =>
      queueCard(
        tx,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      ),
    );
    const post = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
    slack.failNext("chat.postMessage", { lostResponse: true });
    expect(await delivery.post(post.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown" },
    });
    await database.write((tx) => staleApprovals(tx, [approval], "link_changed", now()));
    const item = (await database.read((sql) => readReadyOutbox(sql, now()))).find(
      (item) => item.phase === "update",
    )!;

    expect(await delivery.updateCard(item.id)).toEqual({
      kind: "waiting",
      reason: "card_not_posted",
      until: null,
    });
    expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage"]);
  });

  test.each([
    "failed",
    "dropped",
    "cancelled",
    "superseded",
    "skipped",
    "retracted",
    "stray",
    "sent",
  ])("an update drops when its card post is terminal as %s without a proved ts", async (state) => {
    const { database, slack, delivery, now } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    await database.write((tx) =>
      queueCard(
        tx,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      ),
    );
    await database.write(async (tx) => {
      await tx`UPDATE outbox SET state = ${state} WHERE approval_id = ${approval.id}`;
      await staleApprovals(tx, [approval], "link_changed", now());
    });
    const update = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
    expect(await delivery.updateCard(update.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "card_post_terminal", attempts: 0 },
    });
    expect(slack.calls).toEqual([]);
  });

  test.each(["queued", "sending", "delivery_unknown"])(
    "an update keeps waiting while its unproved post is %s",
    async (state) => {
      const { database, slack, delivery, now } = await setup();
      const approval = await createStoredApproval(database, {
        card: { channelId: "C-link", ts: null },
      });
      await database.write((tx) =>
        queueCard(
          tx,
          { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
          now(),
        ),
      );
      await database.write(async (tx) => {
        await tx`UPDATE outbox SET state = ${state} WHERE approval_id = ${approval.id}`;
        await staleApprovals(tx, [approval], "link_changed", now());
      });
      const update = (await database.read((sql) => readReadyOutbox(sql, now()))).find(
        (item) => item.phase === "update",
      )!;
      expect(await delivery.updateCard(update.id)).toEqual({
        kind: "waiting",
        reason: "card_not_posted",
        until: null,
      });
      expect(slack.calls).toEqual([]);
    },
  );

  test("a card without any initial post cannot leave its decision update waiting forever", async () => {
    const { database, slack, delivery, now } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    await database.write((tx) => staleApprovals(tx, [approval], "link_changed", now()));
    const update = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
    expect(await delivery.updateCard(update.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "card_post_terminal" },
    });
    expect(slack.calls).toEqual([]);
  });

  test("the edit handler refuses a queued initial card post", async () => {
    const { database, slack, delivery, now } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    await database.write((tx) =>
      queueCard(
        tx,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      ),
    );
    const post = (await database.read((sql) => readReadyOutbox(sql, now())))[0]!;
    await expect(delivery.updateCard(post.id)).rejects.toThrow("cannot use chat.update");
    expect(slack.calls).toEqual([]);
  });

  test("a newer card update supersedes an unknown older edit before it can restore the old decision", async () => {
    const { database, slack, delivery, queueUpdate, latestUpdate, approval, now, read } =
      await decidedCard(40);
    const older = await queueUpdate();
    slack.failNext("chat.update", { lostResponse: true });
    expect(await delivery.updateCard(older.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown" },
    });
    await database.write((tx) => staleApprovals(tx, [approval], "link_changed", now()));
    const newer = await latestUpdate();
    expect(await read(older.id)).toMatchObject({ state: "superseded" });

    expect(await delivery.updateCard(newer.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    const expected = await database.read((sql) => readApprovalCard(sql, approval.id));
    expect(
      slack.getMessages("C-link").find((message) => message.ts === approval.card.ts)!.blocks,
    ).toEqual(expected!.message.blocks);
    expect(await delivery.updateCard(older.id)).toEqual({ kind: "changed" });
    expect(slack.calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.update",
    ]);
  });

  test("a replacement waits for the older call and supersedes its late unknown result", async () => {
    const { database, slack, bot, queueUpdate, latestUpdate, approval, now, read } =
      await decidedCard(40);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      async call(method, run) {
        const result = await bot.call(method, run);
        if (method === "chat.update" && !held) {
          held = true;
          received.resolve();
          await release.promise;
        }
        return result;
      },
    };
    const delivery = createPostDelivery(database, checked, { now });
    const older = await queueUpdate();
    slack.failNext("chat.update", { lostResponse: true });
    const pending = delivery.updateCard(older.id);
    await received.promise;
    let newer;
    try {
      await database.write((tx) => staleApprovals(tx, [approval], "link_changed", now()));
      newer = await latestUpdate();
      expect(await delivery.updateCard(newer.id)).toEqual({
        kind: "waiting",
        reason: "card_in_flight",
        until: now() + 1_000,
      });
      expect(slack.calls).toHaveLength(2);
    } finally {
      release.resolve();
      expect(await pending).toMatchObject({
        kind: "settled",
        item: { state: "superseded" },
      });
    }
    expect(await read(older.id)).toMatchObject({ state: "superseded" });
    expect(await delivery.updateCard(newer.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(await delivery.updateCard(older.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(3);
  });
});

test("a pending card cannot create an update that could later restore its buttons", async () => {
  const { slack, delivery, queueUpdate } = await postedCard();
  const item = await queueUpdate();

  expect(await delivery.updateCard(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "approval_pending", attempts: 0 },
  });
  expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage"]);
});

describe("approval card posts", () => {
  test("a card cannot bypass auth_failed through its separate posting gate", async () => {
    const { database, slack, queue, delivery, now } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    const item = await queue({
      kind: "card",
      phase: "post",
      approvalId: approval.id,
      threadTs: null,
      requestId: null,
      requestRev: null,
    });
    await database.write((tx) => markAuthFailed(tx, now()));
    expect(await delivery.post(item.id)).toEqual({
      kind: "waiting",
      reason: "installation_inactive",
      until: null,
    });
    expect(slack.calls).toEqual([]);
  });

  test.each([
    { channelId: "C-other", threadTs: null },
    { channelId: "C-link", threadTs: "100.1" },
  ])("a card cannot move from its approved root destination: %j", async (destination) => {
    const { database, slack, queue, delivery } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    const item = await queue({
      kind: "card",
      phase: "post",
      approvalId: approval.id,
      requestId: null,
      requestRev: null,
      ...destination,
    });

    expect(await delivery.post(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error: "destination_changed", attempts: 0 },
    });
    expect(slack.calls).toEqual([]);
  });

  test("a card waits for a pinned owner before making any call", async () => {
    const { database, slack, queue, delivery } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    const item = await queue({
      kind: "card",
      phase: "post",
      approvalId: approval.id,
      threadTs: null,
      requestId: null,
      requestRev: null,
    });
    await database.write((tx) => tx`UPDATE installation SET owner_user_id = NULL`);

    expect(await delivery.post(item.id)).toEqual({
      kind: "waiting",
      reason: "installation_inactive",
      until: null,
    });
    expect(slack.calls).toEqual([]);
  });

  test("the per-card mutex is not mislabeled as a channel post slot", async () => {
    const { database, slack, queue, delivery, now, advance } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    const card = {
      kind: "card",
      phase: "post",
      approvalId: approval.id,
      threadTs: null,
      requestId: null,
      requestRev: null,
    } as const;
    const first = await queue(card);
    const second = await queue(card);
    await database.write(async (tx) => {
      const view = await readApprovalCard(tx, approval.id);
      const current = await readOutboxItem(tx, first.id);
      if (!view || !current) throw new Error("The fixture needs its queued card.");
      expect(
        await startOutboxAttempt(tx, current, { ...view.message }, "chat.postMessage", now()),
      ).toMatchObject({ kind: "started" });
    });
    advance(1_000);

    expect(await delivery.post(second.id)).toEqual({
      kind: "waiting",
      reason: "card_in_flight",
      until: now() + 1_000,
    });
    expect(slack.calls).toEqual([]);
  });

  test("two queued posts for one approval cannot create two cards", async () => {
    const { database, slack, delivery, now, advance } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    await database.write(async (tx) => {
      for (let count = 0; count < 2; count++) {
        await queueCard(
          tx,
          {
            approvalId: approval.id,
            linkId: "link",
            channelId: "C-link",
            phase: "post",
          },
          now(),
        );
      }
    });
    const [first, second] = await database.read(
      (sql) => sql<{ id: string }[]>`SELECT id FROM outbox ORDER BY number`,
    );

    const results = await Promise.all([delivery.post(first!.id), delivery.post(second!.id)]);
    expect(results.map((result) => result.kind)).toEqual(["settled", "waiting"]);
    expect(slack.calls).toHaveLength(1);
    advance(1_000);
    expect(await delivery.post(second!.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "card_already_posted" },
    });
    expect(slack.calls).toHaveLength(1);
    expect(slack.getMessages("C-link")).toHaveLength(2);
  });

  test("a suspended link's card posts at root and records its receipt in the same transaction", async () => {
    const { database, slack, delivery, now } = await setup({ fresh: false });
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    await database.write(async (tx) => {
      await tx`UPDATE links SET status = 'suspended', status_reason = 'bot_removed'`;
      await queueCard(
        tx,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      );
    });
    const [item] = await database.read((sql) => sql<{ id: string }[]>`SELECT id FROM outbox`);
    const expected = await database.read((sql) => readApprovalCard(sql, approval.id));

    expect(await delivery.post(item!.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", metadataOk: true },
    });
    expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage"]);
    expect(slack.calls[0]!.args).toMatchObject({
      text: expected!.message.text,
      blocks: JSON.stringify(expected!.message.blocks),
      parse: "none",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect(slack.calls[0]!.args).not.toHaveProperty("thread_ts");
    expect((await database.read((sql) => readApproval(sql, approval.id)))!.card.ts).toBe(
      slack.getMessages("C-link")[1]!.ts,
    );
  });

  test("a rejected card post renders the approval's current state on its retry", async () => {
    const { database, slack, delivery, now, advance, read } = await setup();
    const approval = await createStoredApproval(database, {
      card: { channelId: "C-link", ts: null },
    });
    await database.write((tx) =>
      queueCard(
        tx,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      ),
    );
    const [item] = await database.read((sql) => sql<{ id: string }[]>`SELECT id FROM outbox`);
    slack.failNext("chat.postMessage", { retryAfter: 1 });
    expect(await delivery.post(item!.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued" },
    });
    const original = await read(item!.id);
    await database.write((tx) => staleApprovals(tx, [approval], "link_changed", now()));
    const expected = await database.read((sql) => readApprovalCard(sql, approval.id));
    advance(1_000);

    expect(await delivery.post(item!.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attempts: 2 },
    });
    expect(slack.calls[1]!.args).toMatchObject({
      text: expected!.message.text,
      blocks: JSON.stringify(expected!.message.blocks),
      parse: "none",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect((await read(item!.id))!.payloadHash).not.toBe(original!.payloadHash);
    expect(slack.calls[1]!.args.blocks).not.toEqual(slack.calls[0]!.args.blocks);
  });

  test("a purged approval drops its queued post without a network call", async () => {
    const { queue, delivery, slack } = await setup();
    const item = await queue({
      kind: "card",
      phase: "post",
      approvalId: "purged",
      requestId: null,
      requestRev: null,
      threadTs: null,
      payload: {},
    });

    expect(await delivery.post(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "approval_removed", attempts: 0 },
    });
    expect(slack.calls).toEqual([]);
  });
});

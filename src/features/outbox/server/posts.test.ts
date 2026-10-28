import { describe, expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { confirmAnswer } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { createBotClient, guardBotClient, type BotClient } from "@slackapi/server/botClient";
import {
  invalidateChannelInfo,
  readChannelInfo,
  writeChannelInfo,
} from "@slackapi/server/channels";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import { renderMarkdown } from "../model/rendering";
import { queueItem, readOutboxItem, readDueReconciliations, type NewOutboxItem } from "./database";
import { createPostDelivery } from "./posts";
import { createReconciliation } from "./reconcile";

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
  await database.write(
    (tx) => tx`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)`,
  );
  const request = await createStoredRequest(database, {
    requesterUserId,
    state: "answering",
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

test("a locally held channel refresh leaves the queued post eligible without inventing facts", async () => {
  const { database, slack, bot, queue, read, now } = await setup({ fresh: false });
  const item = await queue();
  const delivery = createPostDelivery(
    database,
    guardBotClient(bot, () => false),
    { now },
  );
  expect(await delivery.post(item.id)).toEqual({
    kind: "waiting",
    reason: "slack_unusable",
    until: null,
  });
  expect(await read(item.id)).toMatchObject({ state: "queued", attempts: 0, nextAttemptAt: null });
  expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toBeNull();
  expect(slack.calls).toEqual([]);
});

test("losing usability after channel refresh prevents the post, then resumes without posting twice", async () => {
  const { database, slack, bot, queue, read, now, advance } = await setup({ fresh: false });
  let usable = true;
  const observed: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    call(method, run) {
      return bot.call(method, async (client) => {
        const result = await run(client);
        if (method === "conversations.info") usable = false;
        return result;
      });
    },
  };
  const delivery = createPostDelivery(
    database,
    guardBotClient(observed, () => usable),
    { now },
  );
  const item = await queue();
  expect(await delivery.post(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "queued", error: "slack_unusable", nextAttemptAt: null },
  });
  expect(await read(item.id)).toMatchObject({ state: "queued", attempts: 0 });
  expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
  expect(slack.getMessages("C-link").filter((message) => message.bot_id === "B-bot")).toEqual([]);
  usable = true;
  advance(1000);
  expect(await delivery.post(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(slack.calls.map((call) => call.method)).toEqual([
    "conversations.info",
    "chat.postMessage",
  ]);
  expect(slack.getMessages("C-link").filter((message) => message.bot_id === "B-bot")).toHaveLength(
    1,
  );
});

test.each(["msg_blocks_too_long", "thread_not_found"])(
  "a final Slack refuses with %s goes back to the lead, and its link stays active",
  async (error) => {
    const { database, slack, queue, delivery, readRequestState } = await setup();
    slack.failNext("chat.postMessage", { error });
    const item = await queue();
    expect(await delivery.post(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error },
    });
    expect(await readRequestState()).toMatchObject({
      state: "seen",
      attention: "reply_failed",
      closedReason: null,
    });
    expect(
      await database.read((sql) => sql`SELECT id FROM outbox WHERE kind = 'reaction'`),
    ).toEqual([]);
    expect(await database.read((sql) => sql`SELECT status FROM links`)).toEqual([
      { status: "active" },
    ]);
  },
);

test.each(["sent", "failed", "queued", "delivery_unknown"] as const)(
  "a %s receipt after unlink retains only the post that still needs reconciliation",
  async (state) => {
    const { database, slack, bot, queue, read, now, advance } = await setup({
      timeoutMs: state === "delivery_unknown" ? 40 : 1000,
    });
    const queued = await queue();
    const snapshot = await read(queued.id);
    if (!snapshot) throw new Error("The fixture needs its queued post.");
    const checked: BotClient = {
      cooldown: (method) => bot.cooldown(method),
      call(method, run) {
        return bot.call(method, async (client) => {
          try {
            return await run(client);
          } finally {
            await database.write(async (tx) => {
              await tx`UPDATE outbox SET payload = '{"redacted":"unlink"}' WHERE id = ${queued.id}`;
              await tx`DELETE FROM requests`;
              await tx`DELETE FROM links`;
            });
          }
        });
      },
    };
    if (state === "failed") slack.failNext("chat.postMessage", { error: "msg_blocks_too_long" });
    if (state === "queued") slack.failNext("chat.postMessage", { retryAfter: 1 });
    if (state === "delivery_unknown") slack.failNext("chat.postMessage", { lostResponse: true });
    expect(await createPostDelivery(database, checked, { now }).post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state, payload: { redacted: "unlink" } },
    });
    if (state === "delivery_unknown") {
      expect(await read(queued.id)).toMatchObject({
        state,
        payload: { redacted: "unlink" },
        payloadHash: snapshot.payloadHash,
        attempts: 1,
      });
    } else {
      expect(await read(queued.id)).toBeNull();
    }
    expect(slack.getMessages("C-link")).toHaveLength(
      state === "sent" || state === "delivery_unknown" ? 2 : 1,
    );
    expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage"]);
    if (state === "delivery_unknown") {
      advance(10_000);
      const reconciliation = createReconciliation(database, bot, { now });
      onTestFinished(() => reconciliation.close());
      expect(await reconciliation.reconcile(queued.id)).toMatchObject({
        kind: "settled",
        item: { state: "sent" },
      });
      expect(await read(queued.id)).toBeNull();
      expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    }
  },
);

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
      await database.read(
        (sql) => sql`
          SELECT json_extract(payload, '$.action') AS action,
            json_extract(payload, '$.name') AS name
          FROM outbox WHERE kind = 'reaction'
        `,
      ),
    ).toEqual([{ action: "add", name: "white_check_mark" }]);
    expect(await delivery.post(queued.id)).toEqual({ kind: "changed" });
    expect(slack.calls).toHaveLength(1);
  });

  test("a publication posts to the watched channel without a thread", async () => {
    const { database, slack, queue, delivery } = await setup();
    const queued = await queue({
      kind: "publication",
      phase: null,
      threadTs: null,
      requestId: null,
      requestRev: null,
      publicationKey: "notes/2026-W43",
    });

    expect(await delivery.post(queued.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(slack.calls[0]!.args.channel).toBe("C-link");
    expect(slack.calls[0]!.args).not.toHaveProperty("thread_ts");
    expect(
      await database.read((sql) => sql`SELECT kind FROM outbox WHERE kind = 'reaction'`),
    ).toEqual([]);
  });

  test("an explicit follow-up posts without reopening a terminal request", async () => {
    const { database, queue, delivery, request, readRequestState } = await setup();
    await database.write((tx) => saveRequest(tx, confirmAnswer(request)));
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

  test("fresh cached public facts cannot overrule the owner's narrowed approved audience", async () => {
    const { database, queue, delivery, now, slack } = await setup();
    const audience = privateAudience();
    await database.write(async (tx) => {
      await writeChannelInfo(tx, channelFacts({ kind: "public" }), now());
      await tx`UPDATE links SET approved_audience = ${JSON.stringify({ ...audience, kind: "public" })}`;
    });
    const queued = await queue();
    await database.write(
      (tx) => tx`UPDATE links SET approved_audience = ${JSON.stringify(audience)}`,
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
    "a refresh refused with %s suspends the channel's link, not others",
    async (error, reason) => {
      const { database, slack, queue, delivery, now } = await setup({ fresh: false });
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
      ]);
      expect(slack.calls.map((call) => call.method)).toEqual(["conversations.info"]);
    },
  );

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
    expect(await readRequestState()).toMatchObject({ state: "seen", attention: "reply_failed" });
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
    // The request waits on the withdrawal, which gives it back to the lead.
    expect(await readRequestState()).toMatchObject({ state: "answering" });
    const cleanup = await database.read(
      (sql) => sql`SELECT kind, state, payload FROM outbox WHERE kind = 'retract'`,
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

  test("a channel-wide refusal suspends its link, not unrelated links", async () => {
    const { database, slack, queue, delivery, now } = await setup();
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

import { expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readRequest } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import {
  queueItem,
  readOutboxItem,
  readReadyOutbox,
  recoverOutboxAttempts,
  startOutboxAttempt,
  type NewOutboxItem,
} from "./database";
import { createReactionDelivery } from "./reactions";

async function setup({ timeoutMs = 1_000 } = {}) {
  let at = 1_700_000_200_000;
  const now = () => at;
  const database = await openTestDatabase();
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  onTestFinished(() => slack.stop());
  slack.addChannel({ id: "C-link", members: ["U-owner", "U-bot"] });
  await createStoredInstallation(database);
  await createStoredLink(database);
  const request = await createStoredRequest(database, {
    state: "in_progress",
    seenAt: now(),
    touchedAt: now(),
  });
  slack.setMessage("C-link", { ts: request.sourceTs, user: "U-owner", text: "A question" });
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs,
    now,
  });
  const delivery = createReactionDelivery(database, bot, { now });
  const payload = { action: "add", name: "eyes", timestamp: request.sourceTs };
  const queue = (changes: Partial<NewOutboxItem> = {}) =>
    database.write((tx) =>
      queueItem(
        tx,
        {
          kind: "reaction",
          linkId: request.linkId,
          requestId: request.id,
          channelId: request.channelId,
          payload,
          ...changes,
        },
        now(),
      ),
    );
  const read = (id: string) => database.read((sql) => readOutboxItem(sql, id));
  const readRequestState = () => database.read((sql) => readRequest(sql, request.id));
  const reactions = () =>
    slack.getMessages("C-link").find((message) => message.ts === request.sourceTs)?.reactions ?? [];
  return {
    database,
    slack,
    bot,
    delivery,
    queue,
    payload,
    read,
    request,
    readRequestState,
    reactions,
    now,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("the SDK sees committed sending and only the frozen message reaction arguments", async () => {
  const { database, slack, bot, queue, payload, read, request, readRequestState, now, reactions } =
    await setup();
  const queued = await queue();
  const before = await readRequestState();
  const checked: BotClient = {
    cooldown: (method) => bot.cooldown(method),
    async call(method, run) {
      expect(method).toBe("reactions.add");
      expect(await read(queued.id)).toMatchObject({
        state: "sending",
        attempts: 1,
        attemptMethod: method,
        payload,
        attemptStartedAt: now(),
      });
      return bot.call(method, run);
    },
  };
  expect(await createReactionDelivery(database, checked, { now }).react(queued.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", slackTs: request.sourceTs, evidence: "response", metadataOk: null },
  });
  expect(slack.calls.map(({ method, args }) => ({ method, args }))).toEqual([
    {
      method: "reactions.add",
      args: { channel: "C-link", name: "eyes", timestamp: request.sourceTs },
    },
  ]);
  expect(reactions()).toEqual([{ name: "eyes", count: 1, users: ["U-bot"] }]);
  expect(await readRequestState()).toEqual(before);
  expect(await database.read((sql) => sql`SELECT * FROM outbox_channels`)).toEqual([]);
});

test.each(["paused", "suspended", "removed"])(
  "an eyes removal works with a %s link and no request",
  async (status) => {
    const { database, slack, delivery, queue, payload, request, read, reactions } = await setup();
    slack.setMessage("C-link", {
      ts: request.sourceTs,
      reactions: [{ name: "eyes", count: 1, users: ["U-bot"] }],
    });
    const item = await queue({ payload: { ...payload, action: "remove" } });
    await database.write(async (tx) => {
      await tx`DELETE FROM requests`;
      if (status === "removed") await tx`DELETE FROM links`;
      else await tx`UPDATE links SET status = ${status}`;
    });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(reactions()).toEqual([]);
    expect((await read(item.id)) === null).toBe(status === "removed");
    expect(slack.calls.map((call) => call.method)).toEqual(["reactions.remove"]);
  },
);

test.each(["paused", "suspended"])(
  "a confirmed answer's checkmark works while its link is %s, but new eyes wait",
  async (status) => {
    const { database, delivery, queue, payload, read } = await setup();
    await database.write((tx) => tx`UPDATE links SET status = ${status}`);
    const eyes = await queue();
    expect(await delivery.react(eyes.id)).toEqual({
      kind: "waiting",
      reason: "link_inactive",
      until: null,
    });
    expect(await read(eyes.id)).toMatchObject({ state: "queued", attempts: 0 });
    await database.write((tx) => tx`UPDATE requests SET state = 'answered'`);
    const check = await queue({ payload: { ...payload, name: "white_check_mark" } });
    expect(await delivery.react(check.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
  },
);

test.each([
  { state: "open", seen_at: null },
  { state: "answered" },
  { state: "dismissed", closed_reason: "Not needed" },
  { state: "cancelled", closed_reason: "thread_gone" },
  { state: "expired" },
])("eyes queued for a request that no longer needs them are dropped: %j", async (changes) => {
  const { database, slack, delivery, queue, read } = await setup();
  const item = await queue();
  await database.write((tx) => tx`UPDATE requests SET ${tx(changes)}`);
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "dropped", error: "reaction_no_longer_needed", attempts: 0 },
  });
  expect(await read(item.id)).toMatchObject({ state: "dropped" });
  expect(slack.calls).toEqual([]);
});

test.each([{ link_id: "other" }, { channel_id: "C-other" }, { source_ts: "1700000100.000200" }])(
  "an add cannot inherit a request in a different scope: %j",
  async (changes) => {
    const { database, slack, delivery, queue, readRequestState } = await setup();
    const item = await queue();
    await database.write((tx) => tx`UPDATE requests SET ${tx(changes)}`);
    const before = await readRequestState();
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error: "reaction_target_mismatch", attempts: 0 },
    });
    expect(await readRequestState()).toEqual(before);
    expect(slack.calls).toEqual([]);
  },
);

test("a checkmark cannot claim an unconfirmed answer", async () => {
  const { slack, delivery, queue, payload } = await setup();
  const item = await queue({ payload: { ...payload, name: "white_check_mark" } });
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "dropped", error: "reaction_answer_unconfirmed" },
  });
  expect(slack.calls).toEqual([]);
});

test("a linkless owner-claim checkmark is not mistaken for an orphan", async () => {
  const { delivery, queue, payload, read } = await setup();
  const item = await queue({
    linkId: null,
    requestId: null,
    payload: { ...payload, name: "white_check_mark" },
  });
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(await read(item.id)).not.toBeNull();
});

test.each(["eyes", "white_check_mark"])(
  "unlink drops queued %s locally even while the installation is inactive",
  async (name) => {
    const { database, slack, delivery, queue, payload, read } = await setup();
    const item = await queue({ payload: { ...payload, name } });
    await database.write(async (tx) => {
      await tx`DELETE FROM links`;
      await tx`UPDATE installation SET status = 'auth_failed'`;
    });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "link_removed" },
    });
    expect(await read(item.id)).toBeNull();
    expect(slack.calls).toEqual([]);
  },
);

test("removal still needs an active installation", async () => {
  const { database, slack, delivery, queue, payload, read } = await setup();
  const item = await queue({ payload: { ...payload, action: "remove" } });
  await database.write((tx) => tx`UPDATE installation SET status = 'auth_failed'`);
  expect(await delivery.react(item.id)).toEqual({
    kind: "waiting",
    reason: "installation_inactive",
    until: null,
  });
  expect(await read(item.id)).toMatchObject({ state: "queued", attempts: 0 });
  expect(slack.calls).toEqual([]);
});

test.each(["add", "remove"])(
  "a deleted message is complete feedback, never a request cancellation: %s",
  async (action) => {
    const { slack, delivery, queue, payload, request, readRequestState } = await setup();
    const item = await queue({ payload: { ...payload, action } });
    const before = await readRequestState();
    slack.deleteMessage("C-link", request.sourceTs);
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(await readRequestState()).toEqual(before);
  },
);

test.each(["invalid_name", "thread_locked", "missing_scope"])(
  "a permanent reaction refusal is item-local and leaves the request alone: %s",
  async (error) => {
    const { database, slack, delivery, queue, readRequestState } = await setup();
    slack.failNext("reactions.add", { error });
    const item = await queue();
    const before = await readRequestState();
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "failed", error },
    });
    expect(await readRequestState()).toEqual(before);
    expect(await database.read((sql) => sql`SELECT status FROM links`)).toEqual([
      { status: "active" },
    ]);
  },
);

test.each(["add", "remove"])(
  "a lost %s response retries idempotently with the same method and payload",
  async (action) => {
    const { slack, delivery, queue, payload, request, read, reactions, now, advance } = await setup(
      { timeoutMs: 100 },
    );
    if (action === "remove") {
      slack.setMessage("C-link", {
        ts: request.sourceTs,
        reactions: [{ name: "eyes", count: 1, users: ["U-bot"] }],
      });
    }
    const item = await queue({ payload: { ...payload, action } });
    const method = action === "add" ? "reactions.add" : "reactions.remove";
    slack.failNext(method, { lostResponse: true });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown", attempts: 1, nextAttemptAt: now() + 5_000 },
    });
    const first = await read(item.id);
    expect(await delivery.react(item.id)).toMatchObject({ kind: "waiting" });
    expect(slack.calls).toHaveLength(1);
    advance(5_000);
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attempts: 2, attemptMethod: method, payloadHash: first?.payloadHash },
    });
    expect(slack.calls.map((call) => call.method)).toEqual([method, method]);
    expect(reactions()).toEqual(
      action === "add" ? [{ name: "eyes", count: 1, users: ["U-bot"] }] : [],
    );
  },
);

test.each(["add", "remove"] as const)(
  "an interrupted %s recovers through the same idempotent operation, not message reads",
  async (action) => {
    const { database, slack, delivery, queue, payload, read, now, advance } = await setup();
    const queued = await queue({ payload: { ...payload, action } });
    const item = await read(queued.id);
    if (!item) throw new Error("The fixture needs its reaction.");
    const method = action === "add" ? "reactions.add" : "reactions.remove";
    await database.write(async (tx) => {
      await startOutboxAttempt(tx, item, item.payload, method, now());
      await recoverOutboxAttempts(tx, now());
    });
    expect(await delivery.react(item.id)).toMatchObject({ kind: "waiting" });
    expect(slack.calls).toEqual([]);
    advance(10_000);
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attempts: 2, attemptMethod: method },
    });
    expect(slack.calls.map((call) => call.method)).toEqual([method]);
  },
);

test.each(["installation", "link", "cooldown"])(
  "an uncertain add remains unknown while waiting on its %s",
  async (hold) => {
    const { database, slack, delivery, queue, payload, read, advance } = await setup({
      timeoutMs: 100,
    });
    const item = await queue();
    slack.failNext("reactions.add", { lostResponse: true });
    await delivery.react(item.id);
    advance(5_000);
    if (hold === "installation") {
      await database.write((tx) => tx`UPDATE installation SET status = 'auth_failed'`);
    } else if (hold === "link") {
      await database.write((tx) => tx`UPDATE links SET status = 'paused'`);
    } else {
      const other = await queue({ payload: { ...payload, name: "thumbsup" } });
      slack.failNext("reactions.add", { retryAfter: 240 });
      await delivery.react(other.id);
    }
    expect(await delivery.react(item.id)).toMatchObject({ kind: "waiting" });
    expect(await read(item.id)).toMatchObject({ state: "delivery_unknown", attempts: 1 });
    expect(slack.calls).toHaveLength(hold === "cooldown" ? 2 : 1);
  },
);

test.each(["rate_limited", "auth_failed"])(
  "a rejected retry cannot erase an earlier uncertain add: %s",
  async (failure) => {
    const { slack, delivery, queue, read, advance } = await setup({ timeoutMs: 100 });
    const item = await queue();
    slack.failNext("reactions.add", { lostResponse: true });
    await delivery.react(item.id);
    advance(5_000);
    slack.failNext(
      "reactions.add",
      failure === "rate_limited" ? { retryAfter: 240 } : { error: "token_revoked" },
    );
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown", attempts: 2 },
    });
    expect(await delivery.react(item.id)).toMatchObject({ kind: "waiting" });
    expect(await read(item.id)).toMatchObject({ state: "delivery_unknown", attempts: 2 });
    expect(slack.calls).toHaveLength(2);
  },
);

test("uncertain feedback backs off from five to 120 seconds", async () => {
  const { slack, delivery, queue, read, now, advance } = await setup();
  const item = await queue();
  for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
    slack.failNext("reactions.add", { error: "internal_error" });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown", error: "internal_error", nextAttemptAt: now() + delay },
    });
    expect((await read(item.id))?.nextAttemptAt).toBe(now() + delay);
    advance(delay);
  }
});

test("a shared add cooldown does not delay a removal or invent a second add attempt", async () => {
  const { slack, delivery, queue, payload, read, now } = await setup();
  const first = await queue();
  slack.failNext("reactions.add", { retryAfter: 240 });
  expect(await delivery.react(first.id)).toMatchObject({
    kind: "settled",
    item: { state: "queued", nextAttemptAt: now() + 240_000 },
  });
  const second = await queue();
  expect(await delivery.react(second.id)).toEqual({
    kind: "waiting",
    reason: "rate_limited",
    until: now() + 240_000,
  });
  expect(await read(second.id)).toMatchObject({ state: "queued", attempts: 0 });
  const removal = await queue({ payload: { ...payload, action: "remove" } });
  expect(await delivery.react(removal.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent" },
  });
  expect(slack.calls.map((call) => call.method)).toEqual(["reactions.add", "reactions.remove"]);
});

test("token rejection waits for installation recovery without failing its request", async () => {
  const { database, slack, delivery, queue, read, readRequestState } = await setup();
  const item = await queue();
  const before = await readRequestState();
  slack.failNext("reactions.add", { error: "token_revoked" });
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "queued", error: "token_revoked", nextAttemptAt: null },
  });
  expect(await database.read((sql) => readInstallation(sql))).toMatchObject({
    status: "auth_failed",
  });
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "waiting",
    reason: "installation_inactive",
  });
  expect(await read(item.id)).toMatchObject({ attempts: 1 });
  expect(await readRequestState()).toEqual(before);
  await database.write((tx) => tx`UPDATE installation SET status = 'active'`);
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "sent", attempts: 2 },
  });
});

test.each(["add", "remove"])(
  "a channel refusal holds a reaction until its link is active again: %s",
  async (action) => {
    const { database, slack, delivery, queue, payload, read } = await setup();
    const item = await queue({ payload: { ...payload, action } });
    const method = action === "add" ? "reactions.add" : "reactions.remove";
    slack.failNext(method, { error: "not_in_channel" });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "queued", error: "not_in_channel", nextAttemptAt: null },
    });
    expect(await database.read((sql) => sql`SELECT status, status_reason FROM links`)).toEqual([
      { status: "suspended", status_reason: "bot_removed" },
    ]);
    expect(await delivery.react(item.id)).toMatchObject({ kind: "waiting" });
    expect(await read(item.id)).toMatchObject({ state: "queued", attempts: 1 });
    expect(slack.calls).toHaveLength(1);
    await database.write((tx) => tx`UPDATE links SET status = 'active', status_reason = NULL`);
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent", attempts: 2 },
    });
  },
);

test.each(["add", "remove"])(
  "unlink disposes of a channel-held %s rather than waiting forever",
  async (action) => {
    const { database, slack, delivery, queue, payload, read } = await setup();
    const item = await queue({ payload: { ...payload, action } });
    slack.failNext(action === "add" ? "reactions.add" : "reactions.remove", {
      error: "not_in_channel",
    });
    await delivery.react(item.id);
    await database.write((tx) => tx`DELETE FROM links`);
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "not_in_channel" },
    });
    expect(await read(item.id)).toBeNull();
    expect(await database.read((sql) => sql`SELECT id FROM outbox`)).toEqual([]);
    expect(slack.calls).toHaveLength(1);
  },
);

test.each(["eyes", "white_check_mark"])(
  "an already-unknown %s add compensates after unlink instead of being retried or forgotten",
  async (name) => {
    const { database, slack, delivery, queue, payload, read, reactions, now } = await setup({
      timeoutMs: 100,
    });
    if (name === "white_check_mark") {
      await database.write((tx) => tx`UPDATE requests SET state = 'answered'`);
    }
    const item = await queue({ payload: { ...payload, name } });
    slack.failNext("reactions.add", { lostResponse: true });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "delivery_unknown" },
    });
    await database.write(async (tx) => {
      await tx`DELETE FROM requests`;
      await tx`DELETE FROM links`;
    });
    expect(await delivery.react(item.id)).toMatchObject({
      kind: "settled",
      item: { state: "dropped", error: "link_removed" },
    });
    expect(await read(item.id)).toBeNull();
    const [removal] = await database.read((sql) => readReadyOutbox(sql, now()));
    if (!removal) throw new Error("The unlinked uncertain add needs its compensating removal.");
    expect(await delivery.react(removal.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(reactions()).toEqual([]);
    expect(await read(removal.id)).toBeNull();
    expect(slack.calls.map((call) => call.method)).toEqual(["reactions.add", "reactions.remove"]);
  },
);

test.each([{}, { name: "thumbsup" }, { timestamp: "1700000100.000200" }, { channelId: "C-other" }])(
  "only an in-flight reaction to the same message and emoji blocks another: %j",
  async (changes) => {
    const { database, slack, bot, delivery, queue, payload, request, now } = await setup();
    slack.addChannel({ id: "C-other", members: ["U-bot"] });
    slack.setMessage("C-link", { ts: "1700000100.000200" });
    slack.setMessage("C-other", { ts: request.sourceTs });
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
    const add = await queue();
    const pending = createReactionDelivery(database, held, { now }).react(add.id);
    await received.promise;
    const { channelId = "C-link", ...target } = changes;
    const removal = await queue({
      channelId,
      payload: { ...payload, ...target, action: "remove" },
    });
    const same = Object.keys(changes).length === 0;
    try {
      expect(await delivery.react(removal.id)).toMatchObject(
        same
          ? { kind: "waiting", reason: "reaction_in_flight", until: now() + 1_000 }
          : { kind: "settled", item: { state: "sent" } },
      );
      expect(slack.calls).toHaveLength(same ? 1 : 2);
    } finally {
      release.resolve();
      await pending;
    }
    if (same) {
      expect(await delivery.react(removal.id)).toMatchObject({
        kind: "settled",
        item: { state: "sent" },
      });
    }
    expect(
      await database.read(
        (sql) => sql`SELECT state FROM outbox WHERE kind = 'reaction' ORDER BY number`,
      ),
    ).toEqual([{ state: "sent" }, { state: "sent" }]);
  },
);

test("a late reaction response cannot overwrite a manual resolution", async () => {
  const { database, bot, queue, read, now } = await setup();
  const item = await queue();
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
  const pending = createReactionDelivery(database, held, { now }).react(item.id);
  await received.promise;
  try {
    await database.write(
      (tx) => tx`UPDATE outbox SET state = 'dropped', error = 'operator' WHERE id = ${item.id}`,
    );
  } finally {
    release.resolve();
    expect(await pending).toEqual({ kind: "changed" });
  }
  expect(await read(item.id)).toMatchObject({ state: "dropped", error: "operator" });
});

test("an interrupted reaction cannot change from remove to add", async () => {
  const { database, slack, delivery, queue, read, now } = await setup();
  const queued = await queue();
  const item = await read(queued.id);
  if (!item) throw new Error("The fixture needs its reaction.");
  await database.write(async (tx) => {
    await startOutboxAttempt(tx, item, item.payload, "reactions.remove", now());
    await recoverOutboxAttempts(tx, now());
  });
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "reaction_method_changed" },
  });
  expect(slack.calls).toEqual([]);
});

test.each([
  { unlink: false, lost: false },
  { unlink: false, lost: true },
  { unlink: true, lost: false },
  { unlink: true, lost: true },
  { unlink: true, lost: false, name: "white_check_mark" },
  { unlink: true, lost: true, name: "white_check_mark" },
])(
  "an add finishing after its request goes away queues one compensating removal: %j",
  async ({ unlink, lost, name = "eyes" }) => {
    const { database, slack, bot, delivery, queue, payload, read, request, now, reactions } =
      await setup({
        timeoutMs: 100,
      });
    if (name === "white_check_mark") {
      await database.write((tx) => tx`UPDATE requests SET state = 'answered'`);
    }
    const item = await queue({ payload: { ...payload, name } });
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
    if (lost) slack.failNext("reactions.add", { lostResponse: true });
    const pending = createReactionDelivery(database, held, { now }).react(item.id);
    await received.promise;
    try {
      await database.write(async (tx) => {
        if (unlink) {
          await tx`DELETE FROM requests`;
          await tx`DELETE FROM links`;
        } else {
          await cancelStoredRequest(tx, request, "thread_gone", now());
        }
      });
    } finally {
      release.resolve();
      expect(await pending).toMatchObject({
        kind: "settled",
        item: { state: lost ? "dropped" : "sent" },
      });
    }
    const removals = (await database.read((sql) => readReadyOutbox(sql, now()))).filter(
      (row) => row.kind === "reaction" && row.payload.action === "remove",
    );
    expect(removals).toHaveLength(1);
    expect(reactions()).toEqual([{ name, count: 1, users: ["U-bot"] }]);
    expect(await delivery.react(removals[0]!.id)).toMatchObject({
      kind: "settled",
      item: { state: "sent" },
    });
    expect(reactions()).toEqual([]);
    if (unlink) {
      expect(await read(item.id)).toBeNull();
      expect(await read(removals[0]!.id)).toBeNull();
    }
    expect(slack.calls.map((call) => call.method)).toEqual(["reactions.add", "reactions.remove"]);
  },
);

test.each([
  { action: "toggle", name: "eyes", timestamp: "1700000100.000100" },
  { action: "add", name: "", timestamp: "1700000100.000100" },
  { action: "remove", name: "eyes", timestamp: 123 },
  { action: "remove", name: "eyes", timestamp: "not-a-ts" },
  { action: "remove", name: "eyes", timestamp: "1700000100.000100", file: "F-secret" },
])("invalid feedback is explicitly refused without calling Slack: %j", async (payload) => {
  const { slack, delivery, queue } = await setup();
  const item = await queue({ payload });
  expect(await delivery.react(item.id)).toMatchObject({
    kind: "settled",
    item: { state: "failed", error: "invalid_reaction_payload", attempts: 0 },
  });
  expect(slack.calls).toEqual([]);
});

import { expect, onTestFinished, spyOn, test } from "bun:test";
import { createStoredLink } from "@links/server/testFixtures";
import { startOutboxWorker, type OutboxWorker } from "@outbox/server";
import { queuePublication } from "@outbox/server/database";
import { createOutboxWorld } from "@outbox/server/testFixtures";
import type { BotClient } from "@slackapi/server/botClient";
import { waitFor } from "./waitFor";

test("the timer waits for Slack, checks unknown delivery twice and treats eyes as best-effort", async () => {
  let worker: OutboxWorker | undefined;
  const errors: unknown[] = [];
  onTestFinished(async () => {
    await worker?.stop();
    expect(errors).toEqual([]);
  });
  const world = await createOutboxWorld();
  const item = await world.queue();
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  let ready = false;
  worker = startOutboxWorker(world.database, world.bot, {
    ready: () => ready,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  worker.poke();
  await Bun.sleep(20);
  expect(world.slack.calls).toEqual([]);
  ready = true;
  await waitFor(async () =>
    expect(await world.read(item.id)).toMatchObject({ state: "delivery_unknown" }),
  );
  for (const message of world.slack.getMessages("C-link")) {
    if (message.bot_id === world.slack.identity.botId)
      world.slack.deleteMessage("C-link", message.ts);
  }
  for (const [index, delay] of [60_000, 240_000].entries()) {
    world.advance(delay);
    worker.poke();
    await waitFor(async () =>
      expect(await world.read(item.id)).toMatchObject({ reconcilePass: index + 1 }),
    );
  }
  expect(await world.read(item.id)).toMatchObject({
    state: "delivery_unknown",
    nextAttemptAt: null,
  });
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  world.slack.failNext("reactions.add", { error: "not_reactable" });
  worker.acknowledge([world.request, world.request]);
  await waitFor(() =>
    expect(world.slack.calls.filter((call) => call.method === "reactions.add")).toHaveLength(2),
  );
  expect(world.slack.calls.at(-1)!.args).toMatchObject({
    name: "eyes",
    channel: world.request.channelId,
    timestamp: world.request.sourceTs,
  });
});

test("stop drains an active send and starts no second link's job or pending poke", async () => {
  let worker: OutboxWorker | undefined;
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  onTestFinished(async () => {
    release.resolve();
    await worker?.stop();
    expect(errors).toEqual([]);
  });
  const world = await createOutboxWorld();
  const first = await world.queue();
  await createStoredLink(world.database, "other");
  world.slack.addChannel({ id: "C-other", is_private: true });
  const input = { linkId: "other", series: "notes", scheduledAt: world.now(), text: "Notes" };
  const second = await world.database.write((tx) => queuePublication(tx, input, world.now()));
  const bot: BotClient = {
    async call(method, run) {
      if (method === "chat.postMessage") {
        entered.resolve();
        await release.promise;
      }
      return world.bot.call(method, run);
    },
  };
  worker = startOutboxWorker(world.database, bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  await entered.promise;
  worker.poke();
  worker.poke();
  let stopped = false;
  const stopping = worker.stop().then(() => (stopped = true));
  await Bun.sleep(5);
  expect(stopped).toBe(false);
  release.resolve();
  await stopping;
  expect(await world.read(first.id)).toMatchObject({ state: "sent" });
  expect(await world.read(second.id)).toMatchObject({ state: "queued" });
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("a storage failure stops the worker and reports why without sending", async () => {
  let worker: OutboxWorker | undefined;
  onTestFinished(async () => worker?.stop());
  const world = await createOutboxWorld();
  const item = await world.queue();
  await world.database.write(
    (tx) => tx`
      CREATE TRIGGER disk_full BEFORE UPDATE ON outbox
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
    `,
  );
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errorLog.mockRestore());
  const failure = Promise.withResolvers<unknown>();
  worker = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: failure.resolve,
    now: world.now,
  });
  const error = await failure.promise;
  expect(error).toMatchObject({ message: expect.stringContaining("database or disk is full") });
  worker.poke();
  await worker.stop();
  expect(errorLog.mock.calls).toEqual([["Stopped delivering Slack posts:", error]]);
  expect(await world.read(item.id)).toMatchObject({ state: "queued" });
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
});

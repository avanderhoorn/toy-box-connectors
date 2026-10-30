import { expect, onTestFinished, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import { captureLog } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { startOutboxWorker, type OutboxWorker } from "@outbox/server";
import { queuePublication, queueReply } from "@outbox/server/database";
import { oweFileDeletes } from "@outbox/server/files";
import { createOutboxWorld } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { BotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startSlackForBridge } from "./bridgeProcess";
import { startLinkedBridge } from "./linkedBridge";
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
    ...world.bot,
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
  const logged = captureLog();
  const failure = Promise.withResolvers<unknown>();
  worker = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: failure.resolve,
    now: world.now,
  });
  const error = await failure.promise;
  expect(String(error)).toContain("database or disk is full");
  worker.poke();
  await worker.stop();
  expect(logged()).toEqual([`Stopped delivering Slack posts: ${Bun.inspect(error)}`]);
  expect(await world.read(item.id)).toMatchObject({ state: "queued" });
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
});

test("the worker deletes what the bridge owes once it's due, backs off while Slack keeps a file, and gives up after 30 days", async () => {
  let worker: OutboxWorker | undefined;
  const errors: unknown[] = [];
  onTestFinished(async () => {
    await worker?.stop();
    expect(errors).toEqual([]);
  });
  const world = await createOutboxWorld();
  // F-1 a failed post showed, F-2 Slack deleted already, F-3 Slack won't let the bot delete, first
  // owed 30 days ago, and F-4 a command uploaded, which the post it queues may still show.
  for (const id of ["F-1", "F-4"]) world.slack.addFile("chart", { user: "U-bot", id });
  world.slack.addFile("chart", { user: "U-owner", id: "F-3" });
  const at = world.now();
  await world.database.write(async (tx) => {
    await oweFileDeletes(tx, ["F-1", "F-2"], at, at);
    await oweFileDeletes(tx, ["F-3"], at, at - RETENTION_MS);
    await oweFileDeletes(tx, ["F-4"], at + 300_000, at);
  });
  const logged = captureLog();
  const deletes = () =>
    world.slack.calls.filter((call) => call.method === "files.delete").map(({ args }) => args.file);
  const owed = async () => (await world.owed()).map(({ fileId }) => fileId);
  world.slack.failNext("files.delete", { lostResponse: true });
  worker = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });

  // Slack loses its answer about F-1, which ends the pass, so the next pass tries the others.
  await waitFor(async () => expect(await owed()).toEqual(["F-2", "F-3"]));
  await Bun.sleep(20);
  expect(deletes()).toEqual(["F-1"]);
  worker.poke();
  await waitFor(() => expect(deletes()).toEqual(["F-1", "F-2", "F-3"]));
  expect(logged()).toEqual(["Gave up deleting Slack file F-3 after trying for 30 days."]);

  // The bridge asks about F-1 again a minute later, and when Slack loses that answer too, two after.
  world.slack.failNext("files.delete", { lostResponse: true });
  world.advance(60_000);
  worker.poke();
  await waitFor(async () => expect(await owed()).toEqual([]));
  expect(deletes()).toHaveLength(4);
  world.advance(60_000);
  worker.poke();
  await Bun.sleep(20);
  expect(deletes()).toHaveLength(4);
  world.advance(60_000);
  worker.poke();
  await waitFor(() => expect(deletes()).toEqual(["F-1", "F-2", "F-3", "F-1", "F-1"]));

  // F-4 comes due 5 minutes after its command recorded it, and then nothing is owed.
  world.advance(120_000);
  worker.poke();
  await waitFor(() => expect(deletes()).toHaveLength(6));
  expect(deletes().at(-1)).toBe("F-4");
  expect(await owed()).toEqual([]);
});

test("a reply Slack refuses after removing the bot suspends the link and wakes its lead once", async () => {
  const { slack, env } = startSlackForBridge({
    teamId: "T-home",
    appId: "A-app",
    botId: "B-bot",
    botUserId: "U-bot",
  });
  slack.addChannel({ id: "C-link", is_private: true });
  slack.failNext("chat.postMessage", { error: "not_in_channel" });
  const { toyBox, channelId, bridge, status } = await startLinkedBridge({
    env: { ...env, TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify({ debounce: 0, debounceLimit: 0 }) },
    allowed: ["U-owner"],
    prepare: async (database) => {
      await createStoredInstallation(database);
      const request = await createStoredRequest(database, {
        state: "seen",
        touchedAt: Date.now(),
        createdAt: Date.now(),
      });
      await database.write((tx) =>
        queueReply(tx, { requestId: request.id, text: "The queued answer." }, Date.now()),
      );
    },
  });
  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  expect(await status(channelId)).toMatchObject({
    json: { links: [{ status: "suspended", statusReason: "bot_removed" }] },
  });
  bridge.child.kill("SIGTERM");
  expect((await bridge.exit()).code).toBe(0);
  expect(toyBox.runs).toHaveLength(1);
  expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  expect(slack.getMessages("C-link")).toEqual([]);
}, 15_000);

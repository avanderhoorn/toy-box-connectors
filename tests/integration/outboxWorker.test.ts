import { expect, onTestFinished, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import { captureLog } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { startOutboxWorker, type OutboxWorker } from "@outbox/server";
import { queuePublication, queueReply } from "@outbox/server/database";
import { oweDisplays } from "@outbox/server/displays";
import { oweFileDeletes } from "@outbox/server/files";
import type { Standing } from "@outbox/model/reactions";
import { createOutboxWorld, readOwedDisplays } from "@outbox/server/testFixtures";
import { cancelRequest, dismissRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { BotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startSlackForBridge } from "./bridgeProcess";
import { startLinkedBridge } from "./linkedBridge";
import { waitFor } from "./waitFor";

test("the timer waits for Slack to post or check unknown delivery, and checks it twice", async () => {
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
    const calls = world.slack.calls.length;
    ready = false;
    worker.poke();
    await Bun.sleep(20);
    expect(world.slack.calls).toHaveLength(calls);
    ready = true;
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
});

/** A worker over a link and its request, and what Slack shows on the request's message. */
async function startWatching(asked: Parameters<typeof createOutboxWorld>[0] = {}) {
  const errors: unknown[] = [];
  let worker: OutboxWorker | undefined;
  // Registered before the world's, so the worker stops before the database closes.
  onTestFinished(async () => {
    await worker?.stop();
    expect(errors).toEqual([]);
  });
  const world = await createOutboxWorld(asked);
  let ready = true;
  const started = startOutboxWorker(world.database, world.bot, {
    ready: () => ready,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  worker = started;
  /** The names of the reactions on the request's message. */
  const shown = () => world.slack.reactionNames("C-link", world.request.sourceTs);
  /** Every reaction call Slack got, as `add eyes` and `remove runner`. */
  const reactions = () =>
    world.slack.calls
      .filter((call) => call.method.startsWith("reactions."))
      .map(
        (call) =>
          `${call.method.slice("reactions.".length)} ${(call.args as { name: string }).name}`,
      );
  /** Owes the request's message the display `standing` names, and wakes the worker to settle it. */
  const owe = async (standing: Standing) => {
    await world.oweDisplay(standing);
    started.poke();
  };
  return {
    world,
    worker: started,
    owe,
    shown,
    reactions,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

test("a request shows 👀 once woken and 🏃 once read, and neither once its reply posts", async () => {
  // The request is a reply in a thread, so its message isn't the thread's root.
  const asked = { rootTs: "1700000100.000100", sourceTs: "1700000100.000200" } as const;
  const { world, owe, shown, reactions } = await startWatching(asked);
  await owe("woken");
  await waitFor(() => expect(shown()).toEqual(["eyes"]));
  await owe("working");
  await waitFor(() => expect(shown()).toEqual(["runner"]));

  const reply = await world.queue();
  await waitFor(async () => expect(await world.read(reply.id)).toMatchObject({ state: "sent" }));
  await waitFor(() => expect(shown()).toEqual([]));
  // Each display puts what it shows on before it takes the rest off, so one always shows.
  expect(reactions()).toEqual([
    "add eyes",
    "remove runner",
    "add runner",
    "remove eyes",
    "remove eyes",
    "remove runner",
  ]);
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
});

test("a request the lead read that ends unanswered goes back to 👀", async () => {
  const { owe, shown, reactions } = await startWatching();
  await owe("working");
  await waitFor(() => expect(shown()).toEqual(["runner"]));
  await owe("released");

  await waitFor(() => expect(shown()).toEqual(["eyes"]));
  expect(reactions().slice(-2)).toEqual(["add eyes", "remove runner"]);
});

test("a dismissed request keeps what it shows, though a post in its thread goes out", async () => {
  const { world, owe, shown, reactions } = await startWatching();
  await owe("woken");
  await waitFor(() => expect(shown()).toEqual(["eyes"]));
  await world.database.write((tx) => saveRequest(tx, dismissRequest(world.request, "Not asked.")));

  const post = await world.queuePost({ request: world.request.id });
  await waitFor(async () => expect(await world.read(post.id)).toMatchObject({ state: "sent" }));
  await Bun.sleep(50);
  expect(post.requestId).toBe(world.request.id);
  expect(shown()).toEqual(["eyes"]);
  expect(reactions()).toEqual(["add eyes", "remove runner"]);
});

test("a reply whose response was lost keeps what it shows until reconciliation proves it landed", async () => {
  const { world, worker, owe, shown } = await startWatching();
  await owe("working");
  await waitFor(() => expect(shown()).toEqual(["runner"]));
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  const reply = await world.queue();
  await waitFor(async () =>
    expect(await world.read(reply.id)).toMatchObject({ state: "delivery_unknown" }),
  );
  expect(shown()).toEqual(["runner"]);

  world.advance(60_000);
  worker.poke();
  await waitFor(async () => expect(await world.read(reply.id)).toMatchObject({ state: "sent" }));
  await waitFor(() => expect(shown()).toEqual([]));
});

test("a reply proven sent after its request was cancelled still takes both reactions off", async () => {
  const { world, worker, owe, shown } = await startWatching();
  await owe("working");
  await waitFor(() => expect(shown()).toEqual(["runner"]));
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  const reply = await world.queue();
  await waitFor(async () =>
    expect(await world.read(reply.id)).toMatchObject({ state: "delivery_unknown" }),
  );
  // Deny cancels the request and owes 👀 back, while its reply's outcome is still unknown.
  await world.database.write(async (tx) => {
    const request = (await readRequest(tx, world.request.id))!;
    await saveRequest(tx, cancelRequest(request, "requester_denied"));
  });
  await owe("released");
  await waitFor(() => expect(shown()).toEqual(["eyes"]));

  world.advance(60_000);
  worker.poke();
  await waitFor(async () => expect(await world.read(reply.id)).toMatchObject({ state: "sent" }));
  await waitFor(() => expect(shown()).toEqual([]));
});

test("a reply Slack refuses keeps what it shows, since the lead may answer again", async () => {
  const { world, owe, shown } = await startWatching();
  await owe("working");
  await waitFor(() => expect(shown()).toEqual(["runner"]));
  world.slack.failNext("chat.postMessage", { error: "msg_too_long" });
  const reply = await world.queue();

  await waitFor(async () => expect(await world.read(reply.id)).toMatchObject({ state: "failed" }));
  await Bun.sleep(50);
  expect(shown()).toEqual(["runner"]);
});

test("displays owed while Slack isn't ready leave only the newest to show once it is", async () => {
  const { world, worker, shown, reactions, setReady } = await startWatching();
  setReady(false);
  for (const standing of ["woken", "working", "answered"] as const)
    await world.oweDisplay(standing);
  worker.poke();
  await Bun.sleep(20);
  expect(reactions()).toEqual([]);
  expect(await readOwedDisplays(world.database)).toHaveLength(1);

  setReady(true);
  worker.poke();
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
  expect(shown()).toEqual([]);
  expect(reactions()).toEqual(["remove eyes", "remove runner"]);
});

test("a display owed before the bridge stopped lands once a new worker starts over its database", async () => {
  const world = await createOutboxWorld();
  await world.oweDisplay("woken");
  const run = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => {
      throw error;
    },
    now: world.now,
  });
  onTestFinished(() => run.stop());

  await waitFor(() =>
    expect(world.slack.reactionNames("C-link", world.request.sourceTs)).toEqual(["eyes"]),
  );
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
});

/** A worker whose first 👀 call, which Slack answers as `unanswered` says, owes `working` while out. */
async function overtakenWhileCalling(unanswered: boolean) {
  const errors: unknown[] = [];
  const world = await createOutboxWorld();
  await world.oweDisplay("woken");
  let overtaken = false;
  const bot: BotClient = {
    ...world.bot,
    async call(method, run) {
      const outcome = await world.bot.call(method, run);
      if (method !== "reactions.add" || overtaken) return outcome;
      overtaken = true;
      await world.oweDisplay("working");
      return unanswered ? { kind: "unknown", detail: "timed out" } : outcome;
    },
  };
  const worker = startOutboxWorker(world.database, bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  onTestFinished(async () => {
    await worker.stop();
    expect(errors).toEqual([]);
  });
  await waitFor(() =>
    expect(world.slack.reactionNames("C-link", world.request.sourceTs)).toEqual(["runner"]),
  );
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
}

test("a display owed while the worker's calls are out survives them, and is the one that lands", () =>
  overtakenWhileCalling(false));

test("a display owed while a call Slack left unanswered is out isn't put off with it", () =>
  overtakenWhileCalling(true));

test("a swap Slack rate limits halfway finishes on a later pass, with 👀 still on until then", async () => {
  const { world, worker, owe, shown, reactions } = await startWatching();
  await owe("woken");
  // The 👀 display also removes 🏃, so wait it out before the rate limit is armed for the next.
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
  expect(shown()).toEqual(["eyes"]);
  world.slack.failNext("reactions.remove", { retryAfter: 30 });
  await owe("working");
  await waitFor(() =>
    expect(reactions()).toEqual(["add eyes", "remove runner", "add runner", "remove eyes"]),
  );
  expect(shown()).toEqual(["eyes", "runner"]);

  // Slack's answer reaches the worker after the call shows in the calls, and holds the method for
  // 30 seconds from then, so the clock moves on until the pass that follows isn't held.
  await waitFor(() => {
    world.advance(30_000);
    worker.poke();
    expect(shown()).toEqual(["runner"]);
  });
});

test("a call Slack leaves unanswered is tried again later, without holding up a post", async () => {
  const { world, worker, owe, shown } = await startWatching();
  world.slack.failNext("reactions.add", { status: 503 });
  await owe("woken");
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([{ shows: "eyes", attempts: 1 }]),
  );
  expect(shown()).toEqual([]);

  // Nothing is due for a minute, so the retry hasn't come when a post goes out.
  const post = await world.queuePost();
  await waitFor(async () => expect(await world.read(post.id)).toMatchObject({ state: "sent" }));
  expect(await readOwedDisplays(world.database)).toMatchObject([{ shows: "eyes", attempts: 1 }]);

  world.advance(60_000);
  worker.poke();
  await waitFor(() => expect(shown()).toEqual(["eyes"]));
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
});

test("a newer display replaces one waiting out its backoff, and starts over at once", async () => {
  const { world, owe, shown } = await startWatching();
  world.slack.failNext("reactions.add", { status: 503 });
  await owe("woken");
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([{ shows: "eyes", attempts: 1 }]),
  );

  world.slack.failNext("reactions.add", { status: 503 });
  await owe("working");
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([
      { shows: "runner", attempts: 1 },
    ]),
  );

  world.advance(60_000);
  await owe("working");
  await waitFor(() => expect(shown()).toEqual(["runner"]));
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
});

test("a pass posts first, then tries one display Slack leaves unanswered, then deletes what's due", async () => {
  const errors: unknown[] = [];
  const world = await createOutboxWorld();
  const second = await createStoredRequest(world.database, { sourceTs: "1700000300.000100" });
  const post = await world.queuePost();
  await world.database.write(async (tx) => {
    await oweDisplays(tx, [world.request, second], "woken", world.now());
    await oweFileDeletes(tx, ["F-owed"], world.now(), world.now());
  });
  world.slack.failNext("reactions.add", { status: 503 });
  const worker = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  onTestFinished(async () => {
    await worker.stop();
    expect(errors).toEqual([]);
  });

  const methods = () => world.slack.calls.map((call) => call.method);
  await waitFor(() => expect(methods()).toContain("files.delete"));
  expect(await world.read(post.id)).toMatchObject({ state: "sent" });
  expect(
    methods()
      .slice(0, methods().indexOf("files.delete") + 1)
      .filter((method) => ["chat.postMessage", "reactions.add", "files.delete"].includes(method)),
  ).toEqual(["chat.postMessage", "reactions.add", "files.delete"]);
});

test("a newer display gets its own 30 days, though an older one was owed nearly that long", async () => {
  const { world, worker, owe, setReady } = await startWatching();
  world.slack.failNext("reactions.add", { status: 503 });
  await owe("woken");
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([{ shows: "eyes", attempts: 1 }]),
  );

  // Not ready, so nothing settles the 👀 before the 🏃 replaces it.
  setReady(false);
  world.advance(29 * 24 * 3_600_000);
  await world.oweDisplay("working");
  world.slack.failNext("reactions.add", { status: 503 });
  setReady(true);
  worker.poke();
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([
      { shows: "runner", attempts: 1 },
    ]),
  );

  world.advance(2 * 24 * 3_600_000);
  world.slack.failNext("reactions.add", { status: 503 });
  worker.poke();
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([
      { shows: "runner", attempts: 2 },
    ]),
  );
});

test("a call Slack fails on its side is tried again like one it leaves unanswered", async () => {
  const { world, worker, owe, shown } = await startWatching();
  world.slack.failNext("reactions.add", { error: "internal_error" });
  await owe("woken");
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([{ shows: "eyes", attempts: 1 }]),
  );

  world.advance(60_000);
  worker.poke();
  await waitFor(() => expect(shown()).toEqual(["eyes"]));
});

test("a display Slack never answers is given up after 30 days, and logged", async () => {
  const logged = captureLog();
  const errors: unknown[] = [];
  const world = await createOutboxWorld();
  await world.oweDisplay("woken");
  for (let attempt = 0; attempt < 20; attempt++)
    world.slack.failNext("reactions.add", { status: 503 });
  const worker = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  onTestFinished(async () => {
    await worker.stop();
    expect(errors).toEqual([]);
  });
  await waitFor(async () =>
    expect(await readOwedDisplays(world.database)).toMatchObject([{ attempts: 1 }]),
  );

  world.advance(RETENTION_MS);
  worker.poke();
  await waitFor(async () => expect(await readOwedDisplays(world.database)).toEqual([]));
  expect(logged()).toEqual([
    `Gave up setting the reactions on Slack message ${world.request.sourceTs} in C-link after trying for 30 days.`,
  ]);
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
  // The fake records a call before it answers, so the worker gives up only after that.
  await waitFor(() =>
    expect(logged()).toEqual(["Gave up deleting Slack file F-3 after trying for 30 days."]),
  );

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
  await waitFor(async () => expect(await owed()).toEqual([]));
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

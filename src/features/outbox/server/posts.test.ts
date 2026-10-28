import { expect, test } from "bun:test";
import { readRequest } from "@requests/server/database";
import { tsAt } from "@slackapi/model/ts";
import { queuePublication } from "./database";
import { createPostDelivery } from "./posts";
import { createReconciliation } from "./reconcile";
import { retractPost } from "./retract";
import { createOutboxWorld } from "./testFixtures";

test("one threaded Markdown answer confirms its request, retracts and keeps its reservation", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  const delivery = createPostDelivery(world.database, world.bot, { now: world.now });
  expect(await delivery.post(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
  expect(await world.database.read((sql) => readRequest(sql, world.request.id))).toMatchObject({
    state: "answered",
  });
  const calls = world.slack.calls.filter((call) => call.method === "chat.postMessage");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toMatchObject({
    channel: "C-link",
    thread_ts: world.request.rootTs,
    reply_broadcast: "false",
    parse: "none",
    mrkdwn: "false",
    unfurl_links: "false",
    unfurl_media: "false",
    blocks: JSON.stringify([{ type: "markdown", text: item.payload.text }]),
  });
  await retractPost(world.database, world.bot, "link", item.number, world.now());
  expect(await world.read(item.id)).toMatchObject({ state: "retracted" });
  await expect(world.queue()).rejects.toThrow(`reserved by o${item.number}`);
  expect((await delivery.post(item.id)).kind).toBe("changed");

  world.advance(1000);
  const publication = await world.database.write((tx) =>
    queuePublication(
      tx,
      {
        linkId: "link",
        series: "notes",
        scheduledAt: world.now(),
        text: "# Notes",
      },
      world.now(),
    ),
  );
  expect(await delivery.post(publication.id)).toMatchObject({
    item: { state: "sent", threadTs: null },
  });
});

test("a lost response is confirmed through paginated exact metadata, never a second post", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  const delivery = createPostDelivery(world.database, world.bot, { now: world.now });
  expect(await delivery.post(item.id)).toMatchObject({ item: { state: "delivery_unknown" } });
  world.advance(60_000);
  world.slack.emptyNextPage("conversations.replies");
  expect(
    await createReconciliation(world.database, world.bot, { now: world.now }).reconcile(item.id),
  ).toMatchObject({ item: { state: "sent" } });
  expect(world.slack.calls.filter((call) => call.method === "conversations.replies")).toHaveLength(
    2,
  );
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("accepted then deleted posts remain unknown after two clean misses, and failed reads spend no check", async () => {
  const world = await createOutboxWorld();
  const input = { linkId: "link", series: "notes", scheduledAt: world.now(), text: "# Notes" };
  const item = await world.database.write((tx) => queuePublication(tx, input, world.now()));
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  const delivery = createPostDelivery(world.database, world.bot, { now: world.now });
  await delivery.post(item.id);
  for (const message of world.slack.getMessages("C-link")) {
    if (message.bot_id === "B-bot") world.slack.deleteMessage("C-link", message.ts);
  }
  const unknownSince = (await world.read(item.id))!.unknownSince;
  const checks = createReconciliation(world.database, world.bot, { now: world.now });
  world.advance(60_000);
  world.slack.failNext("conversations.history", { retryAfter: 60 });
  await checks.reconcile(item.id);
  expect(await world.read(item.id)).toMatchObject({ reconcilePass: 0 });
  world.advance(60_000);
  await checks.reconcile(item.id);
  world.advance(30 * 86_400_000);
  await checks.reconcile(item.id);
  expect(await world.read(item.id)).toMatchObject({
    state: "delivery_unknown",
    reconcilePass: 2,
    nextAttemptAt: null,
    unknownSince,
  });
  await expect(
    world.database.write((tx) => queuePublication(tx, input, world.now())),
  ).rejects.toThrow(`reserved by o${item.number}`);
  expect(
    world.slack.calls.find((call) => call.method === "conversations.history")!.args,
  ).toMatchObject({
    oldest: tsAt(input.scheduledAt - 300_000),
    latest: tsAt(input.scheduledAt + 300_000),
  });
  expect((await delivery.post(item.id)).kind).toBe("changed");
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("the current allowlist is checked after queueing and before Slack can receive an answer", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  await world.database.write((tx) => tx`DELETE FROM allowlist WHERE link_id = 'link'`);
  expect(
    await createPostDelivery(world.database, world.bot, { now: world.now }).post(item.id),
  ).toMatchObject({ item: { state: "failed", error: "requester_not_allowed" } });
  expect(world.slack.calls.some((call) => call.method === "chat.postMessage")).toBe(false);
});

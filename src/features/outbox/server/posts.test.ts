import { expect, test } from "bun:test";
import { readRequest } from "@requests/server/database";
import { tsAt } from "@slackapi/model/ts";
import { queuePublication } from "./database";
import { createReconciliation } from "./reconcile";
import { retractPost } from "./retract";
import { createOutboxWorld } from "./testFixtures";

test("one threaded Markdown answer confirms its request, retracts and keeps its reservation", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  expect(await world.post(item.id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
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
  const retract = (link = "link") =>
    retractPost(world.database, world.bot, link, item.number, world.now());
  await expect(retract("other")).rejects.toThrow("belonging to this link");
  expect(world.slack.calls.some((call) => call.method === "chat.delete")).toBe(false);
  world.slack.failNext("chat.delete", { error: "cant_delete_message" });
  await expect(retract()).rejects.toThrow("Deletion is unconfirmed");
  await retract();
  expect(await world.read(item.id)).toMatchObject({ state: "retracted" });
  await expect(world.queue()).rejects.toThrow(`reserved by o${item.number}`);
  expect((await world.post(item.id)).kind).toBe("changed");

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
  expect(await world.post(publication.id)).toMatchObject({
    item: { state: "sent", threadTs: null },
  });
});

test("a lost response is confirmed through paginated exact metadata, never a second post", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  expect(await world.post(item.id)).toMatchObject({ item: { state: "delivery_unknown" } });
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
  await world.post(item.id);
  for (const message of world.slack.getMessages("C-link")) {
    if (message.bot_id === "B-bot") world.slack.deleteMessage("C-link", message.ts);
  }
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
  expect((await world.post(item.id)).kind).toBe("changed");
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test.each([
  ["deny", { item: { state: "failed", error: "requester_not_allowed" } }],
  ["pause", { kind: "waiting", reason: "link_inactive" }],
  ["widen", { kind: "waiting", reason: "channel_not_approved" }],
] as const)("a %s after queueing cannot reach Slack", async (cause, expected) => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  if (cause === "deny")
    await world.database.write((tx) => tx`DELETE FROM allowlist WHERE link_id = 'link'`);
  if (cause === "pause")
    await world.database.write((tx) => tx`UPDATE links SET status = 'paused' WHERE id = 'link'`);
  if (cause === "widen") world.slack.addChannel({ id: "C-link", is_private: false });
  expect(await world.post(item.id)).toMatchObject(expected);
  expect(world.slack.calls.some((call) => call.method === "chat.postMessage")).toBe(false);
});

test("a reply accepted outside its thread remains unknown", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  world.slack.failNext("chat.postMessage", { misplacedReply: true });
  expect(await world.post(item.id)).toMatchObject({
    item: { state: "delivery_unknown", error: "wrong_thread" },
  });
});

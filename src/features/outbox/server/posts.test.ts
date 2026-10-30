import { expect, test } from "bun:test";
import { readRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { tsAt } from "@slackapi/model/ts";
import { queuePublication, type OutboxItem } from "./database";
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
    blocks: JSON.stringify([{ type: "markdown", text: item.payload!.text }]),
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
  ["cancel", { item: { state: "failed", error: "request_no_longer_valid" } }],
  ["pause", { kind: "waiting", reason: "link_inactive" }],
  ["widen", { kind: "waiting", reason: "channel_not_approved" }],
] as const)("a %s after queueing cannot reach Slack", async (cause, expected) => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  if (cause === "deny")
    await world.database.write((tx) => tx`DELETE FROM allowlist WHERE link_id = 'link'`);
  if (cause === "cancel")
    await world.database.write(
      (tx) => tx`UPDATE requests SET state = 'cancelled', closed_reason = 'source_deleted'`,
    );
  if (cause === "pause")
    await world.database.write((tx) => tx`UPDATE links SET status = 'paused' WHERE id = 'link'`);
  if (cause === "widen") world.slack.addChannel({ id: "C-link", is_private: false });
  expect(await world.post(item.id)).toMatchObject(expected);
  expect(world.slack.calls.some((call) => call.method === "chat.postMessage")).toBe(false);
});

test("a post goes out at the top of the channel, or in the thread its request or post names", async () => {
  const world = await createOutboxWorld();
  // r2 opened with a follow-up in a thread, so a post in its thread goes under the thread's root.
  const request = await createStoredRequest(world.database, {
    rootTs: "1700000110.000100",
    sourceTs: "1700000120.000100",
    state: "answered",
  });
  world.slack.setMessage("C-link", {
    type: "message",
    ts: request.rootTs,
    user: "U-owner",
    text: "Root",
  });
  const sent = async ({ id }: OutboxItem) => {
    expect(await world.post(id)).toMatchObject({ kind: "settled", item: { state: "sent" } });
    return world.slack.calls.filter((call) => call.method === "chat.postMessage").at(-1)!.args;
  };

  const top = await world.queuePost();
  expect(await sent(top)).not.toHaveProperty("thread_ts");
  expect(await sent(await world.queuePost({ request: request.id }))).toMatchObject({
    thread_ts: request.rootTs,
    reply_broadcast: "false",
  });
  expect(await sent(await world.queuePost({ post: top.number }))).toMatchObject({
    thread_ts: (await world.read(top.id))!.slackTs,
    reply_broadcast: "false",
  });
});

test.each([
  ["deny", { request: 1 }, "requester_not_allowed"],
  ["cancel", { request: 1 }, "request_no_longer_valid"],
  ["retract", { post: 1 }, "thread_retracted"],
] as const)("a %s after queueing keeps a post out of its thread", async (cause, thread, error) => {
  const world = await createOutboxWorld();
  await world.database.write((tx) => tx`UPDATE requests SET state = 'answered'`);
  const top = await world.queuePost(undefined, "Release notes");
  await world.post(top.id);
  const item = await world.queuePost(thread);
  if (cause === "deny")
    await world.database.write((tx) => tx`DELETE FROM allowlist WHERE link_id = 'link'`);
  if (cause === "cancel")
    await world.database.write(
      (tx) => tx`UPDATE requests SET state = 'cancelled', closed_reason = 'source_deleted'`,
    );
  if (cause === "retract")
    await world.database.write((tx) => tx`UPDATE outbox SET state = 'retracted' WHERE number = 1`);

  expect(await world.post(item.id)).toMatchObject({ item: { state: "failed", error } });
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("a post in a request's thread neither answers the request nor hands it back", async () => {
  const world = await createOutboxWorld();
  const reply = await world.queue();
  const request = () => world.database.read((sql) => readRequest(sql, world.request.id));

  // r1 waits on its reply, so only the reply's outcome may answer it or hand it back.
  await world.post((await world.queuePost({ request: 1 })).id);
  expect(await request()).toMatchObject({ state: "answering" });
  world.slack.failNext("chat.postMessage", { error: "invalid_blocks" });
  const failed = await world.queuePost({ request: 1 }, "And one more thing.");
  expect(await world.post(failed.id)).toMatchObject({ item: { state: "failed" } });
  expect(await request()).toMatchObject({ state: "answering" });
  await world.post(reply.id);
  expect(await request()).toMatchObject({ state: "answered" });
});

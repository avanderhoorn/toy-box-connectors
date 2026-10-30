import { expect, test } from "bun:test";
import { createStoredLink } from "@links/server/testFixtures";
import { serveRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import {
  failQueuedItems,
  forgetOldPosts,
  OutboxRefusedError,
  queuePublication,
  readReadyOutbox,
  recoverOutboxAttempts,
  settleOutboxAttempt,
  startOutboxAttempt,
  type OutboxItem,
} from "./database";
import { createOutboxWorld } from "./testFixtures";

test.each(["deny", "pause"])("a %s before queueing refuses the reply", async (cause) => {
  const world = await createOutboxWorld();
  await world.database.write((tx) =>
    cause === "deny"
      ? tx`DELETE FROM allowlist WHERE link_id = 'link'`
      : tx`UPDATE links SET status = 'paused' WHERE id = 'link'`,
  );
  await expect(world.queue()).rejects.toThrow(cause === "deny" ? "no longer allowed" : "active");
});

test("scheduled slots reserve publications across retraction, without using today's date", async () => {
  const { database, now } = await createOutboxWorld();
  const input = {
    linkId: "link",
    series: "release-notes",
    scheduledAt: now() - 3 * 86_400_000,
    text: "Friday notes",
  };
  const first = await database.write((tx) => queuePublication(tx, input, now()));
  await database.write((tx) => tx`UPDATE outbox SET state = 'retracted' WHERE id = ${first.id}`);
  await expect(
    database.write((tx) => queuePublication(tx, { ...input, text: "Duplicate" }, now())),
  ).rejects.toThrow(`reserved by o${first.number}`);
  expect(
    (await database.write((tx) => queuePublication(tx, { ...input, scheduledAt: now() }, now())))
      .id,
  ).not.toBe(first.id);
});

test("a publication needs a series name and a scheduled run that has already come", async () => {
  const { database, now } = await createOutboxWorld();
  const publish = (input: { series?: string; scheduledAt?: number }) =>
    database.write((tx) =>
      queuePublication(
        tx,
        { linkId: "link", series: "release-notes", scheduledAt: now(), text: "Notes", ...input },
        now(),
      ),
    );
  await expect(publish({ series: "release notes" })).rejects.toThrow(OutboxRefusedError);
  await expect(publish({ scheduledAt: now() + 60_000 })).rejects.toThrow(OutboxRefusedError);
  expect(await publish({})).toMatchObject({ kind: "publication", state: "queued" });
});

test("interrupted sends become unknown, never ready, and reject late attempt settlement", async () => {
  const { database, queue, read, now } = await createOutboxWorld();
  const queued = await queue();
  const started = await database.write((tx) => startOutboxAttempt(tx, queued, now()));
  if (!started) throw new Error("Expected an attempt");
  await database.write((tx) => recoverOutboxAttempts(tx, now()));
  expect(await database.read((sql) => readReadyOutbox(sql, now()))).toEqual([]);
  expect(await read(queued.id)).toMatchObject({ state: "delivery_unknown", attempts: 1 });
  expect(
    await database.write((tx) =>
      settleOutboxAttempt(tx, started, { state: "sent", slackTs: "1700000200.1" }, now()),
    ),
  ).toBeNull();
  const unknown = await read(queued.id);
  if (!unknown) throw new Error("Expected the reserved unknown item");
  expect(
    await database.write((tx) =>
      settleOutboxAttempt(tx, unknown, { state: "failed", error: "not_found" }, now()),
    ),
  ).toBeNull();
  await expect(queue()).rejects.toThrow(`reserved by o${queued.number}`);
});

test("a definite refusal can reuse only its own row, after inbox clears reply_failed", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  const started = await world.database.write((tx) => startOutboxAttempt(tx, item, world.now()));
  if (!started) throw new Error("Expected an attempt");
  await world.database.write((tx) =>
    settleOutboxAttempt(tx, started, { state: "failed", error: "invalid_blocks" }, world.now()),
  );
  await expect(world.queue("Corrected")).rejects.toThrow();
  await world.database.write(async (tx) => {
    const request = await readRequest(tx, world.request.id);
    await saveRequest(tx, serveRequest(request!, world.now()));
  });
  expect(await world.queue("Corrected")).toMatchObject({
    id: item.id,
    state: "queued",
    attempts: 1,
  });
  await world.database.write((tx) => tx`DELETE FROM links WHERE id = 'link'`);
  expect(await world.read(item.id)).toBeNull();
});

test("failing what a link holds queued keeps what may have posted, and gives requests back", async () => {
  const world = await createOutboxWorld();
  const { database, now } = world;
  const publish = (linkId: string, daysAgo: number) => {
    const slot = { linkId, series: "release-notes", scheduledAt: now() - daysAgo * 86_400_000 };
    return database.write((tx) => queuePublication(tx, { ...slot, text: "Notes" }, now()));
  };
  const start = async (item: OutboxItem) => {
    if (!(await database.write((tx) => startOutboxAttempt(tx, item, now()))))
      throw new Error("Expected an attempt");
  };
  const unknown = await publish("link", 2);
  await start(unknown);
  await database.write((tx) => recoverOutboxAttempts(tx, now()));
  const sending = await publish("link", 1);
  await start(sending);
  await createStoredLink(database, "other");
  const elsewhere = await publish("other", 0);
  const reply = await world.queue();
  const publication = await publish("link", 0);

  const failed = await database.write((tx) =>
    failQueuedItems(tx, "link", "audience_widened", now()),
  );

  expect(failed).toMatchObject([
    { id: reply.id, state: "failed", error: "audience_widened" },
    { id: publication.id, state: "failed", error: "audience_widened" },
  ]);
  expect(failed).toHaveLength(2);
  expect(await database.read((sql) => readRequest(sql, world.request.id))).toMatchObject({
    state: "seen",
    attention: "reply_failed",
  });
  expect(await world.read(unknown.id)).toMatchObject({ state: "delivery_unknown" });
  expect(await world.read(sending.id)).toMatchObject({ state: "sending" });
  expect(await world.read(elsewhere.id)).toMatchObject({ state: "queued" });
});

test("a post forgets what it said a month after it last changed, unless it may still go out", async () => {
  const world = await createOutboxWorld();
  const reply = await world.queue();
  const slot = { linkId: "link", series: "release-notes", scheduledAt: world.now(), text: "Notes" };
  const publication = await world.database.write((tx) => queuePublication(tx, slot, world.now()));
  const forgetAfter = async (days: number) => {
    world.advance(days * 86_400_000);
    await world.database.write((tx) => forgetOldPosts(tx, world.now()));
    return { reply: await world.read(reply.id), publication: await world.read(publication.id) };
  };

  // The reply waits over a month, as one queued while its link is paused would, then goes out.
  expect(await forgetAfter(40)).toMatchObject({
    reply: { state: "queued", payload: reply.payload },
  });
  await world.post(reply.id);
  expect(await forgetAfter(29)).toMatchObject({ reply: { state: "sent", payload: reply.payload } });
  expect(await forgetAfter(2)).toMatchObject({
    reply: { state: "sent", payload: null, payloadHash: reply.payloadHash },
    publication: { state: "queued", payload: publication.payload },
  });
});

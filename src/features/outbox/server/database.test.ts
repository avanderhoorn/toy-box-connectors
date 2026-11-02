import { expect, test } from "bun:test";
import { readChannelLink } from "@links/server/database";
import { createStoredLink } from "@links/server/testFixtures";
import { serveRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import {
  failQueuedItems,
  forgetOldPosts,
  OutboxRefusedError,
  queuePost,
  queuePublication,
  readReadyOutbox,
  recoverOutboxAttempts,
  repeatPostMs,
  settleOutboxAttempt,
  startOutboxAttempt,
  type OutboxItem,
} from "./database";
import { renderOutboxAtSend } from "./schema";
import {
  createOutboxWorld,
  createVersion5Item,
  version5Payload,
  version5Post,
} from "./testFixtures";

test("a pause before queueing refuses the reply", async () => {
  const world = await createOutboxWorld();
  await world.database.write((tx) => tx`UPDATE links SET status = 'paused' WHERE id = 'link'`);
  await expect(world.queue()).rejects.toThrow("This request's link isn't active.");
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

test("a post repeating anything in its place is refused while that may still go out, and for a while after it does", async () => {
  const world = await createOutboxWorld();
  const update = "Shipped **1.2**.";
  const repeat = (number: number, state: string) =>
    `o${number} already says this there (${state}).`;
  const settle = (id: string, state: string) =>
    world.database.write(
      (tx) => tx`UPDATE outbox SET state = ${state}, updated_at = ${world.now()} WHERE id = ${id}`,
    );

  // A reply that says it in r1's thread counts, while a post at the top of the channel doesn't,
  // and neither does another link's post at the top of its own channel.
  const reply = await world.queue(update);
  await expect(world.queuePost({ request: 1 }, update)).rejects.toThrow(
    repeat(reply.number, "queued"),
  );
  const first = await world.queuePost(undefined, update);
  await createStoredLink(world.database, "other");
  const elsewhere = await world.database.write(async (tx) => {
    const other = await readChannelLink(tx, "C-other");
    return queuePost(tx, { link: other!, text: update }, world.now());
  });
  expect(elsewhere).toMatchObject({ linkId: "other", state: "queued" });
  for (const state of ["queued", "sending", "delivery_unknown"]) {
    await settle(first.id, state);
    world.advance(30 * 86_400_000);
    await expect(world.queuePost(undefined, update)).rejects.toThrow(repeat(first.number, state));
  }
  await settle(first.id, "sent");
  world.advance(repeatPostMs - 1);
  await expect(world.queuePost(undefined, update)).rejects.toThrow(repeat(first.number, "sent"));
  world.advance(1);
  const second = await world.queuePost(undefined, update);
  await settle(second.id, "failed");
  const third = await world.queuePost(undefined, update);
  await settle(third.id, "retracted");
  expect(await world.queuePost(undefined, update)).toMatchObject({ state: "queued" });
});

test.each(["queued", "delivery_unknown"])(
  "a post version 5 left %s still refuses the same post after the update",
  async (state) => {
    const world = await createOutboxWorld();
    await world.database.write(
      (tx) => tx`INSERT INTO allowlist (link_id, user_id, added_at)
        VALUES ('link', 'U0ALICE', 0), ('link', 'U0BOB', 0)`,
    );
    const top = { kind: "post", request_id: null, thread_ts: null, state };
    await createVersion5Item(world.database, 1, version5Post.payload, top);
    await createVersion5Item(world.database, 2, version5Payload("Shipped."), top);
    await world.database.write(renderOutboxAtSend);

    for (const [index, asked] of [version5Post.asked, { text: "Shipped." }].entries()) {
      const again = world.database.write(async (tx) => {
        const link = await readChannelLink(tx, "C-link");
        return queuePost(tx, { link: link!, ...asked }, world.now());
      });
      await expect(again).rejects.toThrow(`o${index + 1} already says this there (${state}).`);
    }
  },
);

test("an item forgets what it said as soon as it can't go out, and keeps its hash", async () => {
  const world = await createOutboxWorld();
  const states = ["queued", "sending", "sent", "failed", "delivery_unknown", "retracted"];
  const items: OutboxItem[] = [];
  for (const [index, state] of states.entries()) {
    const slot = { linkId: "link", series: "notes", scheduledAt: index, text: `Notes ${index}` };
    const item = await world.database.write((tx) => queuePublication(tx, slot, world.now()));
    await world.database.write(
      (tx) => tx`UPDATE outbox SET state = ${state} WHERE id = ${item.id}`,
    );
    items.push(item);
  }
  const forgetAfter = async (days: number) => {
    world.advance(days * 86_400_000);
    await world.database.write((tx) => forgetOldPosts(tx, world.now()));
    const stored = await Promise.all(items.map(({ id }) => world.read(id)));
    return stored.map((item) => [item?.state, item?.payload !== null, item?.payloadHash]);
  };
  const saying = (...says: boolean[]) =>
    states.map((state, index) => [state, says[index], items[index]?.payloadHash]);

  expect(await forgetAfter(0)).toEqual(saying(true, true, false, false, false, false));
  // One that may still go out keeps it however long it waits, as one queued while its link is
  // paused would.
  expect(await forgetAfter(40)).toEqual(saying(true, true, false, false, false, false));
});

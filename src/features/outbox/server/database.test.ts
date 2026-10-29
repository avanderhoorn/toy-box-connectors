import { expect, test } from "bun:test";
import { serveRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import {
  queuePublication,
  readReadyOutbox,
  recoverOutboxAttempts,
  settleOutboxAttempt,
  startOutboxAttempt,
} from "./database";
import { createOutboxWorld, createStoredOutboxItem } from "./testFixtures";

test("queueing atomically begins answering and reserves the request key in every outcome", async () => {
  const world = await createOutboxWorld();
  const item = await world.queue();
  await expect(world.queue("A different answer")).rejects.toThrow(`reserved by o${item.number}`);
  expect(await world.database.read((sql) => readRequest(sql, world.request.id))).toMatchObject({
    state: "answering",
  });
  for (const state of ["queued", "sent", "failed", "delivery_unknown", "retracted"]) {
    await world.database.write((tx) => tx`UPDATE outbox SET state = ${state}`);
    await expect(createStoredOutboxItem(world.database, 2)).rejects.toThrow("UNIQUE");
  }
});

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

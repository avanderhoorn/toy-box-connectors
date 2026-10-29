// Retention forgets what a post said, never that it was posted, so nothing it forgets posts again.

import { expect, onTestFinished, test } from "bun:test";
import { RETENTION_MS } from "@activity/model/ledger";
import { applyRetention } from "@bridge/server/retention";
import { startOutboxWorker, type OutboxWorker } from "@outbox/server";
import { queuePublication } from "@outbox/server/database";
import { createOutboxWorld } from "@outbox/server/testFixtures";
import { waitFor } from "./waitFor";

test("a post whose text the bridge forgot still settles, and its slot never posts again", async () => {
  let worker: OutboxWorker | undefined;
  const errors: unknown[] = [];
  onTestFinished(async () => {
    await worker?.stop();
    expect(errors).toEqual([]);
  });
  const world = await createOutboxWorld();
  const slot = { linkId: "link", series: "release-notes", scheduledAt: world.now(), text: "Notes" };
  const publication = await world.database.write((tx) => queuePublication(tx, slot, world.now()));
  world.slack.failNext("chat.postMessage", { lostResponse: true });
  worker = startOutboxWorker(world.database, world.bot, {
    ready: () => true,
    onChange: () => {},
    onError: (error) => errors.push(error),
    now: world.now,
  });
  worker.poke();
  await waitFor(async () =>
    expect(await world.read(publication.id)).toMatchObject({ state: "delivery_unknown" }),
  );

  // The bridge was stopped for a month, and forgets before it checks.
  world.advance(RETENTION_MS + 60_000);
  await world.database.write((tx) => applyRetention(tx, world.now()));
  expect(await world.read(publication.id)).toMatchObject({ payload: null });
  worker.poke();
  await waitFor(async () =>
    expect(await world.read(publication.id)).toMatchObject({ state: "sent", payload: null }),
  );
  const again = { ...slot, text: "Notes, again" };
  await expect(
    world.database.write((tx) => queuePublication(tx, again, world.now())),
  ).rejects.toThrow(`reserved by o${publication.number}`);
  expect(world.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

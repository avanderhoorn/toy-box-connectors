import { expect, onTestFinished, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { startToyBoxClient, type ToyBoxClient } from "@toybox/server";
import { defaultWakeTimings } from "@wakes/model";
import { startFakeToyBox } from "../fakes/toybox";
import { waitFor } from "./waitFor";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const REQUESTS_ROUTINE = {
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox` and answer what's waiting.",
};
const TIMINGS = { ...defaultWakeTimings, retry: 20, retryLimit: 80 };

/** A fake Toy Box channel with a requests routine, linked in a fresh database. */
async function linkFakeChannel({ provider }: { provider?: string } = {}) {
  const toyBox = startFakeToyBox({ now: () => NOW });
  const clients: ToyBoxClient[] = [];
  // Registered before the database's own cleanup, so every client stops before it closes.
  onTestFinished(async () => {
    await Promise.all(clients.map((client) => client.stop()));
    await toyBox.stop();
  });
  const database = await openTestDatabase();
  const channelId = toyBox.addChannel({ provider });
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  await createStoredLink(database, "link", {
    toybox_channel_id: channelId,
    requests_routine_id: routine.id,
  });
  const changes: string[] = [];

  async function startClient(
    options: { idleTimeout?: number; onError?: (error: unknown) => void } = {},
  ) {
    const client = startToyBoxClient(database, {
      origin: new URL(toyBox.url),
      onChange: (linkIds) => changes.push(...linkIds),
      now: () => NOW,
      timings: TIMINGS,
      reconnectDelay: 10,
      ...options,
    });
    clients.push(client);
    await client.followLinks();
    await waitFor(() => expect(client.view(channelId).connected).toBe(true));
    return client;
  }

  return { toyBox, database, channelId, routine, changes, startClient };
}

function readStream(database: BridgeDatabase, channelId: string) {
  return database.read(async (sql) => {
    const [row] = await sql`SELECT * FROM toybox_streams WHERE toybox_channel_id = ${channelId}`;
    return row;
  });
}

function readLink(database: BridgeDatabase) {
  return database.read(async (sql) => {
    const [row] = await sql`
      SELECT status, status_reason, routine_state, updated_at FROM links WHERE id = 'link'
    `;
    return row;
  });
}

function readHolds(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, held_at, hold_reason FROM requests ORDER BY id`);
}

/** The milliseconds between each refused stream request and the next. */
function gapsBetween(requests: readonly { at: number }[]): number[] {
  return requests.slice(1).map((request, index) => request.at - requests[index]!.at);
}

test("a first connection stores the snapshot's revision, provider and lead presence", async () => {
  const { toyBox, database, channelId, changes, startClient } = await linkFakeChannel();
  toyBox.setLeadStatus(channelId, {
    state: "waiting",
    text: "Slack requests",
    wakeAt: "2026-10-27T10:00:00.000Z",
  });

  const client = await startClient();

  expect(client.view(channelId)).toEqual({
    connected: true,
    provider: "copilot",
    leadWorking: false,
  });
  expect(toyBox.streamRequests).toEqual([{ channelId, after: null, answer: "snapshot" }]);
  expect(await readStream(database, channelId)).toMatchObject({
    revision: 2,
    provider: "copilot",
    lead_state: "waiting",
    waiting_for: "Slack requests",
    waiting_wake_at: Date.parse("2026-10-27T10:00:00Z"),
    restore_for: null,
  });
  expect(await readLink(database)).toMatchObject({ status: "active", routine_state: "present" });
  expect(changes).toEqual(["link"]);
});

test("a reconnect resumes after the stored revision", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const first = await startClient();
  await first.stop();
  toyBox.postOwnerMessage(channelId, "Ship the release notes today.");

  await startClient();

  expect(toyBox.streamRequests.at(-1)).toEqual({ channelId, after: "1", answer: "resumed" });
  expect(await readStream(database, channelId)).toMatchObject({ revision: 2, owner_spoke_at: NOW });
});

test("a restarted Toy Box is reconnected on the retry backoff and its dead turn reads as idle", async () => {
  const { toyBox, database, channelId, changes, startClient } = await linkFakeChannel();
  const client = await startClient();
  toyBox.startTurn(channelId);
  await waitFor(() => expect(client.view(channelId).leadWorking).toBe(true));

  await toyBox.stop();
  await waitFor(() => expect(client.view(channelId).connected).toBe(false));
  // Several attempts fail while it's down, each further apart than the last.
  await Bun.sleep(150);
  expect(toyBox.streamRequests).toHaveLength(1);
  toyBox.start();

  await waitFor(() => expect(client.view(channelId).connected).toBe(true));
  expect(client.view(channelId).leadWorking).toBe(false);
  expect(toyBox.streamRequests).toEqual([
    { channelId, after: null, answer: "snapshot" },
    { channelId, after: "1", answer: "resumed" },
  ]);
  expect(await readStream(database, channelId)).toMatchObject({ lead_state: "idle" });
  // Connected, working, disconnected, and connected again with the turn over.
  expect(changes).toEqual(["link", "link", "link", "link"]);
});

// TIMINGS retries after 20 ms, doubling up to 80. Timers never fire early, so each gap is at least
// its delay, and only the upper bounds leave room for a slow machine.
test("a stream Toy Box keeps refusing is retried further apart each time, up to the limit", async () => {
  const { toyBox, channelId, startClient } = await linkFakeChannel();
  const client = await startClient();

  toyBox.refuseStreams();

  await waitFor(() => expect(toyBox.refusedStreams.length).toBeGreaterThanOrEqual(5));
  expect(client.view(channelId).connected).toBe(false);
  const [first, second, third, fourth] = gapsBetween(toyBox.refusedStreams);
  expect(first).toBeGreaterThanOrEqual(20);
  expect(second).toBeGreaterThanOrEqual(40);
  expect(third).toBeGreaterThanOrEqual(80);
  expect(fourth).toBeGreaterThanOrEqual(80);
  expect(fourth).toBeLessThan(160);
});

test("a stream that came back starts its backoff over when Toy Box refuses it again", async () => {
  const { toyBox, channelId, startClient } = await linkFakeChannel();
  const client = await startClient();
  toyBox.refuseStreams();
  // Kept failing, the next retry would wait the full 80 ms.
  await waitFor(() => expect(toyBox.refusedStreams.length).toBeGreaterThanOrEqual(4));
  toyBox.acceptStreams();
  await waitFor(() => expect(client.view(channelId).connected).toBe(true));
  const before = toyBox.refusedStreams.length;

  toyBox.refuseStreams();

  await waitFor(() => expect(toyBox.refusedStreams.length).toBeGreaterThanOrEqual(before + 2));
  const [first] = gapsBetween(toyBox.refusedStreams.slice(before));
  expect(first).toBeGreaterThanOrEqual(20);
  expect(first).toBeLessThan(80);
});

test("a gap Toy Box can no longer replay takes its replacement snapshot", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const first = await startClient();
  await first.stop();
  toyBox.postOwnerMessage(channelId, "Ship the release notes today.");
  await toyBox.stop();
  toyBox.start();

  await startClient();

  expect(toyBox.streamRequests.at(-1)).toEqual({ channelId, after: "1", answer: "snapshot" });
  expect(await readStream(database, channelId)).toMatchObject({ revision: 2, owner_spoke_at: NOW });
});

test("routine messages mark the requests routine drifted, present and missing", async () => {
  const { toyBox, database, channelId, routine, changes, startClient } = await linkFakeChannel();
  await startClient();

  toyBox.editRoutine(channelId, routine.id, { prompt: "Answer whatever Slack sent." });
  await waitFor(async () =>
    expect(await readLink(database)).toMatchObject({ routine_state: "drifted" }),
  );
  toyBox.editRoutine(channelId, routine.id, { prompt: REQUESTS_ROUTINE.prompt });
  await waitFor(async () =>
    expect(await readLink(database)).toMatchObject({ routine_state: "present" }),
  );
  toyBox.deleteRoutine(channelId, routine.id);

  await waitFor(async () =>
    expect(await readLink(database)).toEqual({
      status: "active",
      status_reason: null,
      routine_state: "missing",
      updated_at: NOW,
    }),
  );
  expect(changes).toEqual(["link", "link", "link", "link"]);
});

test("a snapshot without the requests routine marks it missing", async () => {
  const { toyBox, database, channelId, routine, startClient } = await linkFakeChannel();
  const first = await startClient();
  await first.stop();
  toyBox.deleteRoutine(channelId, routine.id);
  await toyBox.stop();
  toyBox.start();

  await startClient();

  expect(toyBox.streamRequests.at(-1)?.answer).toBe("snapshot");
  expect(await readLink(database)).toMatchObject({ routine_state: "missing" });
});

test("a series routine's new schedule registers the series again", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const daily = toyBox.scheduleRoutine(channelId, {
    title: "Daily release notes",
    schedule: "0 17 * * *",
    prompt: "Run `toy-box-slack publish --series daily` with today's changes.",
  });
  await database.write(
    (transaction) => transaction`
      INSERT INTO link_routines ${transaction({
        link_id: "link",
        series: "daily",
        routine_id: daily.id,
        routine_state: "present",
        period: "day",
        schedule: "0 17 * * *",
        registered_at: 0,
      })}
    `,
  );
  const readSeries = () =>
    database.read(async (sql) => {
      const [row] = await sql`
        SELECT routine_state, schedule, registered_at FROM link_routines WHERE series = 'daily'
      `;
      return row;
    });
  await startClient();

  toyBox.editRoutine(channelId, daily.id, { prompt: "Post today's changes." });
  await waitFor(async () =>
    expect(await readSeries()).toEqual({
      routine_state: "drifted",
      schedule: "0 17 * * *",
      registered_at: 0,
    }),
  );
  toyBox.editRoutine(channelId, daily.id, {
    schedule: "0 18 * * *",
    prompt: "Run `toy-box-slack publish --series daily` with today's changes.",
  });

  await waitFor(async () =>
    expect(await readSeries()).toEqual({
      routine_state: "present",
      schedule: "0 18 * * *",
      registered_at: NOW,
    }),
  );
});

test("the owner's next message in Toy Box releases the holds taken before it", async () => {
  const { toyBox, database, channelId, changes, startClient } = await linkFakeChannel();
  const held = { state: "seen", seenAt: 1, holdReason: "asked the owner" } as const;
  await createStoredRequest(database, { ...held, heldAt: NOW - 1_000 });
  await createStoredRequest(database, { ...held, heldAt: NOW + 1_000, requesterUserId: "U-x" });
  await startClient();
  changes.length = 0;

  toyBox.postOwnerMessage(channelId, "Go ahead and answer Alice.");

  await waitFor(async () =>
    expect(await readHolds(database)).toEqual([
      { id: 1, held_at: null, hold_reason: null },
      { id: 2, held_at: NOW + 1_000, hold_reason: "asked the owner" },
    ]),
  );
  expect(changes).toEqual(["link"]);
});

test("a deleted channel suspends its link, cancels its requests and is never followed again", async () => {
  const { toyBox, database, channelId, changes, startClient } = await linkFakeChannel();
  await createStoredRequest(database, { state: "in_progress", seenAt: 1 });
  await createStoredRequest(database, { state: "answered", seenAt: 1, requesterUserId: "U-x" });
  await createStoredOutboxItem(database, 1, { request_id: 1 });
  const client = await startClient();

  toyBox.deleteChannel(channelId);

  await waitFor(async () =>
    expect(await readLink(database)).toMatchObject({
      status: "suspended",
      status_reason: "toybox_channel_deleted",
    }),
  );
  expect(
    await database.read((sql) => sql`SELECT id, state, closed_reason FROM requests ORDER BY id`),
  ).toEqual([
    { id: 1, state: "cancelled", closed_reason: "toybox_channel_deleted" },
    { id: 2, state: "answered", closed_reason: null },
  ]);
  expect(await database.read((sql) => sql`SELECT state FROM outbox ORDER BY number`)).toEqual([
    { state: "cancelled" },
    { state: "queued" },
  ]);
  expect(client.view(channelId)).toEqual({ connected: false, provider: null, leadWorking: false });
  expect(changes.at(-1)).toBe("link");

  await client.followLinks();
  await Bun.sleep(50);
  expect(toyBox.streamRequests).toHaveLength(1);
});

test("a bridge that starts after its channel was deleted suspends the link once", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const first = await startClient();
  await first.stop();
  toyBox.deleteChannel(channelId);

  for (const attempt of [1, 2]) {
    const changes: string[] = [];
    const client = startToyBoxClient(database, {
      origin: new URL(toyBox.url),
      onChange: (linkIds) => changes.push(...linkIds),
      now: () => NOW + attempt,
    });
    await client.followLinks();
    await waitFor(() => expect(changes).toEqual(["link"]));
    await client.stop();
  }

  expect(toyBox.streamRequests.slice(1).map(({ answer }) => answer)).toEqual([
    "deleted",
    "deleted",
  ]);
  expect(await readLink(database)).toMatchObject({ status: "suspended", updated_at: NOW + 1 });
});

test("the waiting status a lead showed survives the turn a scheduled run starts", async () => {
  const { toyBox, database, channelId, routine, startClient } = await linkFakeChannel();
  toyBox.setLeadStatus(channelId, {
    state: "waiting",
    text: "Slack requests",
    wakeAt: "2026-10-27T10:00:00.000Z",
  });
  const client = await startClient();

  toyBox.runScheduled(channelId, routine.id);

  await waitFor(async () =>
    expect(await readStream(database, channelId)).toMatchObject({
      lead_state: "working",
      waiting_for: null,
      restore_for: "Slack requests",
      restore_wake_at: Date.parse("2026-10-27T10:00:00Z"),
    }),
  );
  expect(client.view(channelId).leadWorking).toBe(true);

  // A reconnect mid-turn can't tell whether the turn changed, so it keeps what it had.
  await client.stop();
  await startClient();
  expect(await readStream(database, channelId)).toMatchObject({ restore_for: "Slack requests" });

  toyBox.finishTurn(channelId);
  await waitFor(async () =>
    expect(await readStream(database, channelId)).toMatchObject({
      lead_state: "idle",
      restore_for: null,
    }),
  );
});

test("a frame the bridge can't read still moves the revision a reconnect resumes after", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const client = await startClient();

  toyBox.commitNewKindOfEvent(channelId);

  await waitFor(async () =>
    expect(await readStream(database, channelId)).toMatchObject({ revision: 2 }),
  );
  await client.stop();
  await startClient();
  expect(toyBox.streamRequests.at(-1)).toEqual({ channelId, after: "2", answer: "resumed" });
});

test("an error recording a frame stops following instead of retrying", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const errors: unknown[] = [];
  const client = await startClient({ onError: (error) => errors.push(error) });
  await database.write(
    (transaction) => transaction`
      CREATE TRIGGER fail_stream_writes BEFORE UPDATE ON toybox_streams
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
    `,
  );

  toyBox.postOwnerMessage(channelId, "Ship the release notes today.");

  await waitFor(() => expect(errors).toHaveLength(1));
  expect(errors[0]).toMatchObject({ message: expect.stringContaining("disk I/O error") });
  expect(client.view(channelId).connected).toBe(false);
  await waitFor(() => expect(toyBox.connections(channelId)).toBe(0));
  await Bun.sleep(50);
  expect(toyBox.streamRequests).toHaveLength(1);
  expect(await readStream(database, channelId)).toMatchObject({
    revision: 1,
    owner_spoke_at: null,
  });
});

test("a stream that goes quiet is dropped and resumed", async () => {
  const { toyBox, channelId, startClient } = await linkFakeChannel();

  await startClient({ idleTimeout: 50 });

  await waitFor(() => expect(toyBox.streamRequests.length).toBeGreaterThanOrEqual(3));
  expect(toyBox.streamRequests.slice(1).every(({ answer }) => answer === "resumed")).toBe(true);
  expect(toyBox.connections(channelId)).toBeLessThanOrEqual(1);
});

test("following again drops a channel whose link is gone and stopping closes every stream", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const other = toyBox.addChannel();
  await createStoredLink(database, "other", { toybox_channel_id: other });
  const client = await startClient();
  await waitFor(() => expect(client.view(other).connected).toBe(true));

  await database.write((transaction) => transaction`DELETE FROM links WHERE id = 'link'`);
  await client.followLinks();

  expect(client.view(channelId).connected).toBe(false);
  expect(client.view(other).connected).toBe(true);
  await waitFor(() => expect(toyBox.connections(channelId)).toBe(0));
  await client.stop();
  await waitFor(() => expect(toyBox.connections(other)).toBe(0));
});

test("a lead on another provider shows its provider", async () => {
  const { channelId, startClient } = await linkFakeChannel({ provider: "claude" });

  const client = await startClient();

  expect(client.view(channelId)).toMatchObject({ provider: "claude" });
});

test("callers asking together share one catalog read, kept until a member joins or leaves", async () => {
  const { toyBox, channelId, startClient } = await linkFakeChannel();
  const client = await startClient();
  expect(client.catalog()).toBeNull();

  const [first, second] = await Promise.all([client.loadCatalog(), client.loadCatalog()]);
  expect(toyBox.catalogReads).toBe(1);
  expect(second).toBe(first);
  expect(client.catalog()).toBe(first);
  expect(first.channels.map(({ id }) => id)).toEqual([channelId]);

  const memberId = toyBox.addMember(channelId, "Reviewer");
  await waitFor(() => expect(client.catalog()).toBeNull());
  expect((await client.loadCatalog()).members).toEqual([
    { id: memberId, channelId, name: "Reviewer" },
  ]);

  toyBox.removeMember(memberId);
  await waitFor(() => expect(client.catalog()).toBeNull());
  expect((await client.loadCatalog()).members).toEqual([]);
  expect(toyBox.catalogReads).toBe(3);
});

test("a catalog read that a member change overtakes answers its callers but isn't kept", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const client = await startClient();
  const { revision } = await readStream(database, channelId);
  const release = toyBox.holdCatalog();
  const before = client.loadCatalog();
  await waitFor(() => expect(toyBox.catalogReads).toBe(1));

  const memberId = toyBox.addMember(channelId, "Reviewer");
  await waitFor(async () => {
    expect((await readStream(database, channelId)).revision).toBe(revision + 1);
  });
  release();

  expect((await before).members).toEqual([]);
  expect(client.catalog()).toBeNull();
  const after = await client.loadCatalog();
  expect(toyBox.catalogReads).toBe(2);
  expect(after.members.map(({ id }) => id)).toEqual([memberId]);
  expect(client.catalog()).toBe(after);
});

test("a member change starts a new catalog read instead of sharing the one on its way", async () => {
  const { toyBox, database, channelId, startClient } = await linkFakeChannel();
  const client = await startClient();
  const { revision } = await readStream(database, channelId);
  const release = toyBox.holdCatalog();
  const before = client.loadCatalog();
  await waitFor(() => expect(toyBox.catalogReads).toBe(1));

  const memberId = toyBox.addMember(channelId, "Reviewer");
  await waitFor(async () => {
    expect((await readStream(database, channelId)).revision).toBe(revision + 1);
  });
  const after = client.loadCatalog();
  await waitFor(() => expect(toyBox.catalogReads).toBe(2));
  release();

  expect((await before).members).toEqual([]);
  expect((await after).members.map(({ id }) => id)).toEqual([memberId]);
  expect(client.catalog()).toBe(await after);
});

test("a catalog read that fails isn't shared with the next caller", async () => {
  const { toyBox, startClient } = await linkFakeChannel();
  const client = await startClient();
  await toyBox.stop();

  await expect(client.loadCatalog()).rejects.toThrow();
  toyBox.start();

  expect((await client.loadCatalog()).channels).toHaveLength(1);
  expect(client.catalog()).not.toBeNull();
});

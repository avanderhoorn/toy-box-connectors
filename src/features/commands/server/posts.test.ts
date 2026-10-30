import { expect, mock, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { clockTime } from "@commands/model/wording";
import { createStoredLink } from "@links/server/testFixtures";
import { createOutboxWorld, createStoredOutboxItem } from "@outbox/server/testFixtures";
import type { Request } from "@requests/model/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import { postCommand, publishCommand, replyCommand, retractCommand } from "./posts";
import { refusal } from "./testFixtures";

const LEAD = { channelId: "toybox-link" };

test("reply queues one answer in a request's thread, and refuses a second or another channel's request", async () => {
  const { database, now } = await createOutboxWorld();
  await createStoredLink(database, "other");
  await createStoredRequest(database, { linkId: "other", channelId: "C-other", state: "seen" });
  const outbox = { poke: mock(() => {}) };
  const reply = replyCommand({ database, outbox });
  const lead = { ...LEAD, at: now() };

  expect(await reply({ request: 1, text: "It's **fixed**." }, lead)).toEqual({
    result: { request: "r1", post: "o1", state: "queued" },
    text: "Queued o1 to answer r1 in its thread. If it can't post, inbox shows r1 again.",
  });
  expect(await refusal(reply({ request: 1, text: "Again." }, lead))).toBe(
    "r1 wasn't answered. Request r1 is already reserved by o1 (queued). Run `toy-box-slack inbox` to see what waits on you.",
  );
  // Another channel's request is refused like a missing one, so the lead learns nothing of it.
  for (const request of [2, 9]) {
    expect(await refusal(reply({ request, text: "Done." }, lead))).toBe(
      `This channel has no request r${request}. Run \`toy-box-slack inbox\` to see what waits on you.`,
    );
  }
  expect(outbox.poke).toHaveBeenCalledTimes(1);
});

test("publish posts once for the latest scheduled run of the routine that runs it", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const routine = {
    id: "notes",
    title: "Release notes",
    schedule: "0 16 * * 5",
    prompt: "Post this week's release notes with `toy-box-slack publish --series notes`.",
  };
  const outbox = { poke: mock(() => {}) };
  const publish = publishCommand({
    database,
    outbox,
    routines: async (channelId) => (channelId === "toybox-link" ? [routine] : null),
  });
  const friday = new Date(2026, 9, 30, 16, 0).getTime();
  const run = `the run of "Release notes" scheduled ${clockTime(friday)}`;

  expect(
    await publish({ series: "notes", text: "# Notes" }, { ...LEAD, at: friday + 60_000 }),
  ).toEqual({
    result: { post: "o1", series: "notes", scheduledAt: friday, state: "queued" },
    text: `Queued o1 in #C-link for ${run}.`,
  });
  const saturday = { ...LEAD, at: new Date(2026, 9, 31, 9, 0).getTime() };
  expect(await refusal(publish({ series: "notes", text: "# Again" }, saturday))).toBe(
    `Nothing posted for ${run}. This publication slot is already reserved by o1 (queued).`,
  );
  expect(await refusal(publish({ series: "weekly", text: "# Weekly" }, saturday))).toBe(
    "Nothing posted, because no routine in this channel runs `toy-box-slack publish --series weekly`. Publish posts once for each scheduled run of that routine, so create it first.",
  );
  expect(outbox.poke).toHaveBeenCalledTimes(1);
});

test("post queues in the channel or the thread it names, and refuses another channel's request or post", async () => {
  const { database, now } = await createOutboxWorld();
  await database.write((tx) => tx`UPDATE requests SET state = 'answered'`);
  const outbox = { poke: mock(() => {}) };
  const post = postCommand({ database, outbox });
  const lead = { ...LEAD, at: now() };
  const text = "Shipped **1.2**.";

  expect(await post({ text }, lead)).toEqual({
    result: { post: "o1", thread: null, state: "queued" },
    text: "Queued o1 in #C-link.",
  });
  await database.write(
    (tx) => tx`UPDATE outbox SET state = 'sent', slack_ts = '1700000200.000100' WHERE number = 1`,
  );
  expect(await post({ thread: { request: 1 }, text }, lead)).toEqual({
    result: { post: "o2", thread: "r1", state: "queued" },
    text: "Queued o2 in r1's thread.",
  });
  expect(await post({ thread: { post: 1 }, text }, lead)).toEqual({
    result: { post: "o3", thread: "o1", state: "queued" },
    text: "Queued o3 in o1's thread.",
  });
  // Another channel's request or post is refused like a missing one, so the lead learns nothing of it.
  await createStoredLink(database, "other");
  await createStoredRequest(database, { linkId: "other", channelId: "C-other", state: "answered" });
  await createStoredOutboxItem(database, 4, {
    link_id: "other",
    channel_id: "C-other",
    kind: "post",
    request_id: null,
    thread_ts: null,
    state: "sent",
    slack_ts: "1700000300.000100",
  });
  for (const request of [2, 9]) {
    expect(await refusal(post({ thread: { request }, text }, lead))).toBe(
      `Nothing posted. This channel has no request r${request}.`,
    );
  }
  for (const number of [4, 9]) {
    expect(await refusal(post({ thread: { post: number }, text }, lead))).toBe(
      `Nothing posted. This channel has no post o${number}.`,
    );
  }
  expect(outbox.poke).toHaveBeenCalledTimes(3);
});

test.each([
  [1, "o1 is in r1's thread, so post there with `--thread r1`."],
  [3, "o3 is in o2's thread, so post there with `--thread o2`."],
  [4, "o4 isn't in Slack yet, so try again shortly."],
  [5, "o5 isn't in Slack yet, so try again shortly."],
  [6, "o6 has no thread to post in (delivery_unknown)."],
  [7, "o7 has no thread to post in (failed)."],
  [8, "o8 has no thread to post in (retracted)."],
])("post says why o%d's thread takes no post", async (number, why) => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database, { state: "answered" });
  const top = { kind: "post", request_id: null, thread_ts: null };
  await createStoredOutboxItem(database, 1, { state: "sent", slack_ts: "1700000110.000100" });
  await createStoredOutboxItem(database, 2, {
    ...top,
    state: "sent",
    slack_ts: "1700000120.000100",
  });
  await createStoredOutboxItem(database, 3, {
    ...top,
    thread_ts: "1700000120.000100",
    state: "sent",
    slack_ts: "1700000130.000100",
  });
  for (const [n, state] of [
    [4, "queued"],
    [5, "sending"],
    [6, "delivery_unknown"],
    [7, "failed"],
    [8, "retracted"],
  ] as const) {
    await createStoredOutboxItem(database, n, { ...top, state });
  }
  const post = postCommand({ database });

  expect(await refusal(post({ thread: { post: number }, text: "More." }, { ...LEAD, at: 0 }))).toBe(
    `Nothing posted. ${why}`,
  );
});

test.each<{
  title: string;
  link?: { status: "paused" };
  r1?: Partial<Request>;
  r2?: Partial<Request>;
  why: string;
}>([
  { title: "while the link is paused", link: { status: "paused" }, why: "This link isn't active." },
  {
    title: "while another request in that thread is new",
    r2: { state: "open" },
    why: "r2 waits on its answer in that thread, so answer it first.",
  },
  {
    title: "while another request in that thread is read",
    r2: { state: "seen" },
    why: "r2 waits on its answer in that thread, so answer it first.",
  },
  {
    title: "once r1 is cancelled",
    r1: { state: "cancelled", closedReason: "source_deleted" },
    why: "r1 was cancelled, so its thread takes no posts.",
  },
  {
    title: "once r1's requester isn't allowed",
    r1: { requesterUserId: "U-carol" },
    why: "r1's requester is no longer allowed, so its thread takes no posts.",
  },
])("post refuses r1's thread $title", async ({ link, r1, r2, why }) => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", link);
  await database.write(
    (tx) => tx`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)`,
  );
  await createStoredRequest(database, { state: "answered", ...r1 });
  if (r2) await createStoredRequest(database, { sourceTs: "1700000150.000100", ...r2 });
  const post = postCommand({ database });

  expect(await refusal(post({ thread: { request: 1 }, text: "More." }, { ...LEAD, at: 0 }))).toBe(
    `Nothing posted. ${why}`,
  );
});

test("retract deletes the lead's post from Slack, says what stays used, and says why when it can't", async () => {
  const world = await createOutboxWorld();
  const { id } = await world.queue();
  await world.post(id);
  const lead = { ...LEAD, at: world.now() };
  const retract = retractCommand({ database: world.database, bot: world.bot });

  const offline = retractCommand({ database: world.database, bot: null });
  expect(await refusal(offline({ post: 1 }, lead))).toBe("o1 wasn't deleted. Slack isn't active.");
  expect(await refusal(retract({ post: 2 }, lead))).toBe(
    "o2 wasn't deleted. This is not a known post belonging to this link.",
  );
  expect(await retract({ post: 1 }, lead)).toEqual({
    result: { post: "o1", state: "retracted" },
    text: "Deleted o1 from Slack. Its request or run stays used, so nothing posts in its place.",
  });
  expect(await world.read(id)).toMatchObject({ state: "retracted" });
  // A post reserved nothing, so nothing stays used.
  await world.post((await world.queuePost()).id);
  expect((await retract({ post: 2 }, lead)).text).toBe("Deleted o2 from Slack.");
});

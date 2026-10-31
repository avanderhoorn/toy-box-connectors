import { expect, mock, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { COMMAND_TIMEOUT } from "@commands/model/protocol";
import { clockTime } from "@commands/model/wording";
import { blankPng } from "@files/model/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readDueDeletions } from "@outbox/server/files";
import { createOutboxWorld, createStoredOutboxItem } from "@outbox/server/testFixtures";
import type { Request } from "@requests/model/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { BotClient } from "@slackapi/server/botClient";
import { postCommand, publishCommand, replyCommand, retractCommand } from "./posts";
import type { FakeSlack } from "../../../../tests/fakes/slack";
import { refusal } from "./testFixtures";

const LEAD = { channelId: "toybox-link" };

test("reply queues one answer in a request's thread, and refuses a second or another channel's request", async () => {
  const { database, now } = await createOutboxWorld();
  await createStoredLink(database, "other");
  await createStoredRequest(database, { linkId: "other", channelId: "C-other", state: "seen" });
  const outbox = { poke: mock(() => {}) };
  const reply = replyCommand({ database, bot: null, outbox });
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
    bot: null,
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
  const post = postCommand({ database, bot: null, outbox });
  const lead = { ...LEAD, at: now() };
  const text = "Shipped **1.2**.";

  expect(await post({ text }, lead)).toEqual({
    result: { post: "o1", thread: null, mentions: [], state: "queued" },
    text: "Queued o1 in #C-link.",
  });
  await database.write(
    (tx) => tx`UPDATE outbox SET state = 'sent', slack_ts = '1700000200.000100' WHERE number = 1`,
  );
  expect(await post({ thread: { request: 1 }, text }, lead)).toEqual({
    result: { post: "o2", thread: "r1", mentions: [], state: "queued" },
    text: "Queued o2 in r1's thread.",
  });
  expect(await post({ thread: { post: 1 }, text }, lead)).toEqual({
    result: { post: "o3", thread: "o1", mentions: [], state: "queued" },
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

test("post mentions only people on the allowlist, once each, and names whom it notifies", async () => {
  const { database, now } = await createOutboxWorld();
  await database.write(async (tx) => {
    await tx`INSERT INTO users (user_id, real_name) VALUES ('U0ALICE', 'Alice Chen')`;
    await tx`
      INSERT INTO allowlist (link_id, user_id, added_at)
      VALUES ('link', 'U0ALICE', 0), ('link', 'U0BOB', 0)
    `;
  });
  const post = postCommand({ database, bot: null });
  const lead = { ...LEAD, at: now() };

  expect(await post({ mention: ["U0ALICE", "U0BOB", "U0ALICE"], text: "Shipped." }, lead)).toEqual({
    result: { post: "o1", thread: null, mentions: ["U0ALICE", "U0BOB"], state: "queued" },
    text: "Queued o1 in #C-link, mentioning Alice Chen and U0BOB.",
  });
  expect(await refusal(post({ mention: ["U0MALLORY"], text: "Shipped again." }, lead))).toBe(
    "Nothing posted. U0MALLORY isn't on the allowlist, so a post can't mention them.",
  );
  expect(
    await refusal(post({ mention: ["U0ALICE", "U0MALLORY", "U0EVE"], text: "Again." }, lead)),
  ).toBe(
    "Nothing posted. U0MALLORY and U0EVE aren't on the allowlist, so a post can't mention them.",
  );
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
  const post = postCommand({ database, bot: null });

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
    title: "while another request in that thread waits on its answer",
    r2: { state: "open" },
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
  const post = postCommand({ database, bot: null });

  expect(await refusal(post({ thread: { request: 1 }, text: "More." }, { ...LEAD, at: 0 }))).toBe(
    `Nothing posted. ${why}`,
  );
});

/** What Slack's refusal says when the Slack app lacks `scope`. */
const lacking = (scope: string) =>
  `the Slack app doesn't have the ${scope} scope yet. Ask the owner to add it on the app's OAuth & Permissions page and reinstall the app to the workspace`;

test.each<{
  title: string;
  image?: Uint8Array[];
  alt?: string[];
  offline?: true;
  slack?: (slack: FakeSlack) => void;
  meanwhile?: (database: BridgeDatabase) => Promise<unknown>;
  why: string;
  owed: number;
}>([
  {
    title: "that isn't a PNG",
    image: [blankPng(2, 2), new TextEncoder().encode("GIF89a")],
    alt: ["Build times this week", "Build times last week"],
    why: "Image 2 isn't a PNG.",
    owed: 0,
  },
  {
    title: "whose alt text holds a credential",
    alt: ["The chart at https://ci:hunter2@ci.example.com/builds"],
    why: "Cannot post: Remove credentials (url_credentials) from image 1's alt text.",
    owed: 0,
  },
  {
    title: "while Slack isn't active",
    offline: true,
    why: "Slack isn't active.",
    owed: 0,
  },
  {
    title: "while the Slack app can't upload files",
    slack: (slack) => slack.failNext("files.getUploadURLExternal", { error: "missing_scope" }),
    why: `Image 1 couldn't be uploaded since ${lacking("files:write")}.`,
    owed: 0,
  },
  {
    title: "when Slack gives an address off its file host",
    slack: (slack) => slack.setUploadOrigin("http://127.0.0.1:9"),
    why: "Image 1 couldn't be uploaded since Slack gave an address off its file host.",
    owed: 1,
  },
  {
    title: "when Slack's answer to its upload is lost",
    slack: (slack) => slack.failNext("files.completeUploadExternal", { lostResponse: true }),
    why: "Image 1 couldn't be uploaded since Slack didn't answer, so try again shortly.",
    owed: 1,
  },
  {
    title: "while the Slack app can't read files",
    slack: (slack) => slack.failNext("files.info", { error: "missing_scope" }),
    why: `Image 1 couldn't be uploaded since ${lacking("files:read")}.`,
    owed: 1,
  },
  {
    title: "that Slack never finishes processing",
    slack: (slack) => slack.stallProcessing(),
    why: "Image 1 couldn't be uploaded since Slack took too long to process it, so try again shortly.",
    owed: 1,
  },
  {
    title: "once its link is paused while it uploads",
    meanwhile: (database) => database.write((tx) => tx`UPDATE links SET status = 'paused'`),
    why: "This request's link isn't active.",
    owed: 1,
  },
])(
  "reply refuses an image $title, queuing nothing and owing a delete of any file it uploaded",
  async ({ image = [blankPng(2, 2)], alt = ["Build times this week"], offline, ...row }) => {
    const world = await createOutboxWorld();
    row.slack?.(world.slack);
    const reply = replyCommand({
      database: world.database,
      bot: offline ? null : world.bot,
      timings: {
        now: world.now,
        sleep: async (ms) => {
          world.advance(ms);
          await row.meanwhile?.(world.database);
        },
      },
    });

    const input = { request: 1, text: "It's **fixed**.", image, alt };
    expect(await refusal(reply(input, { ...LEAD, at: world.now() }))).toBe(
      `r1 wasn't answered. ${row.why} Run \`toy-box-slack inbox\` to see what waits on you.`,
    );
    expect(await world.database.read((sql) => sql`SELECT number FROM outbox`)).toEqual([]);
    expect(await world.owed()).toHaveLength(row.owed);
  },
);

test.each([
  { slow: "files.completeUploadExternal", refused: 2 },
  { slow: "files.getUploadURLExternal", refused: 1 },
  { slow: "upload", refused: 1 },
])(
  "reply starts nothing after $slow brings it to its 30-second deadline, refusing image $refused",
  async ({ slow, refused }) => {
    const world = await createOutboxWorld();
    const steps: string[] = [];
    /** Notes a step Slack finished, reaching the deadline at once if it's the slow one. */
    const finished = <Result>(step: string, result: Result) => {
      steps.push(step);
      if (step === slow) world.advance(30_000);
      return result;
    };
    const bot: BotClient = {
      ...world.bot,
      async call(method, run) {
        return finished(method, await world.bot.call(method, run));
      },
      async upload(file) {
        return finished("upload", await world.bot.upload(file));
      },
    };
    const reply = replyCommand({ database: world.database, bot, timings: { now: world.now } });

    const image = [blankPng(2, 2), blankPng(3, 3)];
    const input = { request: 1, text: "It's **fixed**.", image, alt: ["Before", "After"] };
    expect(await refusal(reply(input, { ...LEAD, at: world.now() }))).toBe(
      `r1 wasn't answered. Image ${refused} couldn't be uploaded since Slack took too long, so try again shortly. Run \`toy-box-slack inbox\` to see what waits on you.`,
    );
    expect(steps.at(-1)).toBe(slow);
  },
);

test("reply owes a delete of each image it uploads until it queues the post, due once the CLI stops waiting and within 5 minutes", async () => {
  const world = await createOutboxWorld();
  /** How many deletes are due within `ms`. */
  const dueWithin = (ms: number) =>
    world.database.read(async (sql) => (await readDueDeletions(sql, world.now() + ms)).length);
  let processing: number[] | undefined;
  const reply = replyCommand({
    database: world.database,
    bot: world.bot,
    timings: {
      now: world.now,
      sleep: async (ms) => {
        processing ??= [await dueWithin(COMMAND_TIMEOUT), await dueWithin(5 * 60_000)];
        world.advance(ms);
      },
    },
  });

  const image = [blankPng(2, 2), blankPng(3, 3)];
  const input = { request: 1, text: "It's **fixed**.", image, alt: ["Before", "After"] };
  await reply(input, { ...LEAD, at: world.now() });
  // So the worker deletes neither while the command may still use it, and both after a crash.
  expect(processing).toEqual([0, 2]);
  expect(await world.database.read((sql) => sql`SELECT file_id FROM file_deletions`)).toEqual([]);
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

test("retract owes a delete of each of a post's images, due at once, once Slack confirms its message is gone", async () => {
  const world = await createOutboxWorld();
  const { id } = await world.queue("Here's the chart.", ["F-1", "F-2"]);
  await world.post(id);
  const retract = retractCommand({ database: world.database, bot: world.bot });
  const lead = { ...LEAD, at: world.now() };
  // Slack deletes the message but loses its answer, so it may still show the images.
  world.slack.failNext("chat.delete", { lostResponse: true });

  expect(await refusal(retract({ post: 1 }, lead))).toBe(
    "o1 wasn't deleted. Deletion is unconfirmed (unknown). Retrying this same post is safe.",
  );
  expect(await world.owed()).toEqual([]);
  expect((await retract({ post: 1 }, lead)).text).toBe(
    "Deleted o1 from Slack. Its request or run stays used, so nothing posts in its place.",
  );
  expect((await world.owed()).map(({ fileId }) => fileId)).toEqual(["F-1", "F-2"]);
});

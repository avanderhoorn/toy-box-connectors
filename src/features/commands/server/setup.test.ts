import { expect, onTestFinished, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { pauseLink, suspendLink } from "@links/server/status";
import { countRows, createStoredLink, fillEveryTable } from "@links/server/testFixtures";
import { queuePublication, queueReply } from "@outbox/server/database";
import { createOutboxWorld } from "@outbox/server/testFixtures";
import { readRequest } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage } from "@slackapi/model/testFixtures";
import type { BotClient } from "@slackapi/server/botClient";
import { startFakeToyBox } from "../../../../tests/fakes/toybox";
import {
  allowCommand,
  linkCommand,
  pauseCommand,
  resumeCommand,
  unlinkCommand,
  type SetupCommandOptions,
} from "./setup";
import { refusal } from "./testFixtures";

const MOVED =
  "The link to #C-link is suspended because Slack gave its channel a new ID. Run `toy-box-slack unlink`, then have the owner link the channel again by its new ID.";

/** Commands that can't reach Toy Box or Slack, so they show what's decided before either is asked. */
const offline = (database: BridgeDatabase) => ({
  database,
  bot: null,
  toyBoxOrigin: new URL("http://127.0.0.1"),
});

const OWNER = { channelId: "toybox-link", at: 1_000 };

test("link and resume refuse a link Slack gave a new channel ID, by either ID, before they ask Toy Box or Slack", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", {
    status: "suspended",
    status_reason: "channel_id_changed",
  });
  const resume = resumeCommand(offline(database));
  const link = linkCommand(offline(database));

  expect(await refusal(resume({}, OWNER))).toBe(MOVED);
  expect(await refusal(link({ slackChannel: "C-link" }, OWNER))).toBe(MOVED);
  expect(await refusal(link({ slackChannel: "C-moved" }, OWNER))).toBe(MOVED);
});

test("a link Slack gives a new channel ID while link asks Slack is refused as it writes", async () => {
  const { database, bot } = await createOutboxWorld();
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  await database.write(
    (transaction) => transaction`UPDATE links SET toybox_channel_id = ${channelId}`,
  );
  const moving: BotClient = {
    ...bot,
    async call(method, run) {
      const call = await bot.call(method, run);
      await database.write((transaction) =>
        suspendLink(transaction, "link", "channel_id_changed", 0),
      );
      return call;
    },
  };
  const options = { database, bot: moving, toyBoxOrigin: new URL(toyBox.url) };

  const answer = linkCommand(options)({ slackChannel: "C-link" }, { channelId, at: 1_000 });

  expect(await refusal(answer)).toBe(MOVED);
  expect(await database.read((sql) => sql`SELECT status, status_reason FROM links`)).toEqual([
    { status: "suspended", status_reason: "channel_id_changed" },
  ]);
});

test("pause leaves a suspended link as it is, and says why it's suspended and what ends it", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", {
    status: "suspended",
    status_reason: "channel_id_changed",
  });
  const links = () => database.read((sql) => sql`SELECT * FROM links`);
  const before = await links();

  expect(await pauseCommand(offline(database))({}, OWNER)).toEqual({
    result: { status: "suspended" },
    text: "The link to #C-link is suspended because Slack gave its channel a new ID, so nothing new opens and nothing posts. Run `toy-box-slack unlink`, then have the owner link the channel again by its new ID.",
  });
  expect(await links()).toEqual(before);
});

test("pause answers that a link that was active is paused", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", { status: "active" });

  expect(await pauseCommand(offline(database))({}, OWNER)).toEqual({
    result: { status: "paused" },
    text: "The link to #C-link is paused, so nothing new opens and nothing posts. Have the owner run `toy-box-slack resume`.",
  });
});

test("unlink deletes what the bridge kept for its link, and nothing of another link's", async () => {
  const database = await openTestDatabase();
  await fillEveryTable(database);
  const before = await countRows(database);
  await createStoredLink(database, "gone");
  const message = askMessage(undefined, { channelId: "C-gone" });
  await createStoredMessage(database, message);
  await createStoredRequest(database, { linkId: "gone", channelId: "C-gone" });

  await unlinkCommand(offline(database))({}, { channelId: "toybox-gone", at: 1_000 });

  expect(await countRows(database)).toEqual(before);
});

test("unlink still deletes the images its link's queued replies would have shown", async () => {
  const world = await createOutboxWorld();
  await world.queue("Build minutes.", ["F-1"]);

  await unlinkCommand(offline(world.database))({}, OWNER);

  expect(await world.owed()).toEqual([{ fileId: "F-1", attempts: 0, createdAt: OWNER.at }]);
});

test("names the app it runs in, once the bridge hosts several, when that app isn't connected to Slack", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const allow = (app: string | null) =>
    allowCommand({ ...offline(database), app })({ users: ["U-new"] }, OWNER);

  expect(await refusal(allow(null))).toBe(
    "The bridge isn't connected to Slack, so nothing changed. Run `toy-box-slack status` to see why.",
  );
  expect(await refusal(allow("releases"))).toBe(
    "The releases app isn't connected to Slack, so nothing changed. Run `toy-box-slack status` to see why.",
  );
});

/** Link commands that reach Slack and a Toy Box with one channel the stored link doesn't name. */
async function linking() {
  const { database, slack, bot } = await createOutboxWorld();
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const options: SetupCommandOptions = { database, bot, toyBoxOrigin: new URL(toyBox.url) };
  return { database, slack, channelId, options };
}

/** Allow for the stored link, reaching a Slack where Ada and Bo are full members. */
async function allowing() {
  const { database, slack, bot } = await createOutboxWorld();
  for (const [id, real_name] of [
    ["U-ada", "Ada"],
    ["U-bo", "Bo"],
  ] as const) {
    slack.setUser({
      id,
      team_id: "T-home",
      real_name,
      is_bot: false,
      is_restricted: false,
      is_ultra_restricted: false,
    });
  }
  const allow = allowCommand({ ...offline(database), bot });
  return { database, slack, allow: (...users: string[]) => allow({ users }, OWNER) };
}

test("allow names whom it allowed, and the channel as Slack names it", async () => {
  const { allow } = await allowing();

  expect(await allow("U-ada")).toEqual({
    result: { added: ["U-ada"] },
    text: "Ada (U-ada) can ask the lead to act from #fake-channel now.",
  });
  expect(await allow("U-ada", "U-bo")).toEqual({
    result: { added: ["U-bo"] },
    text: "They can all ask the lead to act from #fake-channel now:\n\n- Ada (U-ada)\n- Bo (U-bo)",
  });
});

test("allow goes ahead when Slack doesn't say the channel's name, naming the channel by its ID", async () => {
  const { slack, allow } = await allowing();
  slack.failNext("conversations.info", { error: "internal_error" });

  expect(await allow("U-ada")).toEqual({
    result: { added: ["U-ada"] },
    text: "Ada (U-ada) can ask the lead to act from #C-link now.",
  });
});

test("allow keeps the channel's name, and names it by the one it kept when Slack doesn't say", async () => {
  const { database, slack, allow } = await allowing();
  const stored = () => database.read((sql) => sql`SELECT slack_channel_name AS name FROM links`);

  await allow("U-ada");
  expect(await stored()).toEqual([{ name: "fake-channel" }]);

  slack.addChannel({ id: "C-link", name: "renamed" });
  slack.failNext("conversations.info", { error: "internal_error" });
  expect((await allow("U-bo")).text).toContain("from #fake-channel now");
});

test("a Slack channel linked to another Toy Box channel is refused, saying another app can link it", async () => {
  const { channelId, options } = await linking();
  const link = (app: string | null) =>
    linkCommand({ ...options, app })({ slackChannel: "C-link" }, { channelId, at: 1_000 });

  expect(await refusal(link(null))).toBe(
    "#fake-channel is linked to another Toy Box channel. Unlink it there, or add another app with `toy-box-slack add-app` and link this one through it.",
  );
  expect(await refusal(link("releases"))).toBe(
    "#fake-channel is linked to another Toy Box channel through the releases app. Unlink it there, or link this one through another app with `--app`.",
  );
});

/**
 * Resume and link for the stored link, reaching Slack and Toy Box, while it holds r1's answer and a
 * publication.
 */
async function resuming() {
  const world = await createOutboxWorld();
  const { database, bot, now } = world;
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  await database.write(
    (transaction) => transaction`UPDATE links SET toybox_channel_id = ${channelId}`,
  );
  const reply = await world.queue();
  const slot = { linkId: "link", series: "release-notes", scheduledAt: now(), text: "Notes" };
  const publication = await database.write((transaction) =>
    queuePublication(transaction, slot, now()),
  );
  const options: SetupCommandOptions = { database, bot, toyBoxOrigin: new URL(toyBox.url) };
  const resume = resumeCommand(options);
  const link = linkCommand(options);
  return {
    ...world,
    held: [reply, publication],
    resume: () => resume({}, { channelId, at: now() }),
    /** Links the stored link's channel again, taking requests in `requests` mode. */
    link: (requests: "mention" | "all") =>
      link({ slackChannel: "C-link", requests }, { channelId, at: now() }),
  };
}

test("resume fails what its link held once more people can read the channel, and gives the lead back each request still waiting", async () => {
  const { database, slack, request, now, read, held, resume, queuePost } = await resuming();
  // A post in r1's thread leaves r1 to its answer, so it doesn't give r1 back again.
  const post = await queuePost({ request: request.id });
  // r2's requester was denied while its answer was held, so the lead doesn't get r2 back.
  const denied = await createStoredRequest(database, {
    state: "seen",
    rootTs: "1700000100.000300",
    sourceTs: "1700000100.000300",
  });
  const late = await database.write(async (transaction) => {
    const queued = await queueReply(transaction, { requestId: denied.id, text: "Late." }, now());
    const asked = await readRequest(transaction, denied.id);
    await cancelStoredRequest(transaction, asked!, "requester_denied");
    await suspendLink(transaction, "link", "channel_made_public", now());
    return queued;
  });
  slack.addChannel({ id: "C-link", is_private: false });

  const answer = await resume();

  expect(answer.result).toMatchObject({ status: "active", dropped: ["o1", "o2", "o3", "o4"] });
  expect(answer.text).toEndWith(
    "More people can read #fake-channel than when the lead wrote these, so they won't post:\n\n- o1, its answer to r1\n- o2, its release-notes publication\n- o3, its post in r1's thread\n- o4, its answer to r2\n\nThe lead gets r1 back to answer again.",
  );
  for (const item of [...held, post, late]) {
    expect(await read(item.id)).toMatchObject({ state: "failed", error: "audience_widened" });
  }
  expect(await database.read((sql) => readRequest(sql, request.id))).toMatchObject({
    state: "seen",
    attention: "reply_failed",
  });
});

test("resume judges the channel against the audience the owner approved, so one made public while paused fails what the link held", async () => {
  const { database, slack, read, held, resume } = await resuming();
  await database.write((transaction) => pauseLink(transaction, "link", 0));
  slack.addChannel({ id: "C-link", is_private: false });

  expect((await resume()).result).toMatchObject({ dropped: ["o1", "o2"] });
  for (const item of held) expect(await read(item.id)).toMatchObject({ state: "failed" });
});

test("resume names no posts when its link held none as more people came to read the channel", async () => {
  const { database, slack, now, held, post, resume } = await resuming();
  for (const item of held) await post(item.id);
  await database.write((transaction) =>
    suspendLink(transaction, "link", "channel_made_public", now()),
  );
  slack.addChannel({ id: "C-link", is_private: false });

  const answer = await resume();

  expect(answer.result).toMatchObject({ status: "active", dropped: [] });
  expect(answer.text).not.toContain("won't post");
});

test("resume posts the replies and publications a paused link held when no more people can read the channel", async () => {
  const { database, read, held, resume } = await resuming();
  await database.write((transaction) => pauseLink(transaction, "link", 0));

  const answer = await resume();

  expect(answer.result).toMatchObject({ status: "active", dropped: [] });
  expect(answer.text).not.toContain("won't post");
  for (const item of held) expect(await read(item.id)).toMatchObject({ state: "queued" });
});

test("resume fails the posts a paused link held, since the owner may have paused it to stop them", async () => {
  const { database, request, read, resume, queuePost } = await resuming();
  const posts = [await queuePost(), await queuePost({ request: request.id })];
  await database.write((transaction) => pauseLink(transaction, "link", 0));

  const answer = await resume();

  expect(answer.result).toMatchObject({ status: "active", dropped: ["o3", "o4"] });
  expect(answer.text).toEndWith(
    "The link was paused after the lead wrote these, so they won't post:\n\n- o3, its post at the top of the channel\n- o4, its post in r1's thread\n\nAsk the lead again for any you still want.",
  );
  for (const post of posts) {
    expect(await read(post.id)).toMatchObject({ state: "failed", error: "link_stopped" });
  }
});

test("resume fails the post a suspended link held once Slack shows its channel as the owner approved it", async () => {
  const { database, now, read, resume, queuePost } = await resuming();
  const post = await queuePost();
  await database.write((transaction) => suspendLink(transaction, "link", "bot_removed", now()));

  const answer = await resume();

  expect(answer.result).toMatchObject({ status: "active", dropped: ["o3"] });
  expect(answer.text).toEndWith(
    "The link was suspended after the lead wrote o3, its post at the top of the channel, so it won't post. Ask the lead again if you still want it.",
  );
  expect(await read(post.id)).toMatchObject({ state: "failed", error: "link_stopped" });
});

test("link stores the channel's name as Slack gives it", async () => {
  const { database, link } = await resuming();

  await link("mention");

  expect(await database.read((sql) => sql`SELECT slack_channel_name AS name FROM links`)).toEqual([
    { name: "fake-channel" },
  ]);
});

test("link names the channel its Toy Box channel is already linked to by the name it stored", async () => {
  const { database, slack, channelId, options } = await linking();
  await database.write(
    (transaction) =>
      transaction`UPDATE links SET toybox_channel_id = ${channelId}, slack_channel_name = 'stored-name'`,
  );
  slack.addChannel({ id: "C-other", is_private: true, shared_team_ids: ["T-home"] });

  const answer = linkCommand(options)({ slackChannel: "C-other" }, { channelId, at: 1_000 });

  expect(await refusal(answer)).toBe(
    "This Toy Box channel is linked to #stored-name. Run `toy-box-slack unlink` before you link it to another channel.",
  );
});

test("link leaves what an active link holds queued as it changes its settings, posts too", async () => {
  const { read, held, link, queuePost } = await resuming();
  const post = await queuePost();

  const answer = await link("all");

  expect(answer.result).toMatchObject({ status: "active", requestMode: "all", dropped: [] });
  for (const item of [...held, post])
    expect(await read(item.id)).toMatchObject({ state: "queued" });
});

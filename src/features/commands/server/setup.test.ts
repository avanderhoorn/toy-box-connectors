import { expect, onTestFinished, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { suspendLink } from "@links/server/status";
import { countRows, createStoredLink, fillEveryTable } from "@links/server/testFixtures";
import { createOutboxWorld } from "@outbox/server/testFixtures";
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

test.each([
  { was: "active", is: "paused" },
  { was: "paused", is: "already paused" },
] as const)("pause answers that a link that was $was is $is", async ({ was, is }) => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", { status: was });

  expect(await pauseCommand(offline(database))({}, OWNER)).toEqual({
    result: { status: "paused" },
    text: `The link to #C-link is ${is}, so nothing new opens and nothing posts. Have the owner run \`toy-box-slack resume\`.`,
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
  const { database, bot } = await createOutboxWorld();
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const options: SetupCommandOptions = { database, bot, toyBoxOrigin: new URL(toyBox.url) };
  return { database, channelId, options };
}

test("a link through a named app says whose bot answers", async () => {
  const { database, channelId, options } = await linking();
  await database.write(
    (transaction) => transaction`UPDATE links SET toybox_channel_id = ${channelId}`,
  );
  const link = (app: string | null) =>
    linkCommand({ ...options, app })({ slackChannel: "C-link" }, { channelId, at: 1_000 });

  expect((await link("releases")).text.split("\n")[0]).toBe(
    'The lead of "Linked" answers in #fake-channel now as the releases app\'s bot, for the people `toy-box-slack allow` names.',
  );
  expect((await link(null)).text.split("\n")[0]).toBe(
    'The lead of "Linked" answers in #fake-channel now, for the people `toy-box-slack allow` names.',
  );
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

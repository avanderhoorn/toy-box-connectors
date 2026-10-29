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
import { linkCommand, pauseCommand, resumeCommand, unlinkCommand } from "./setup";
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

test("a link Slack gives a new channel ID while link asks Slack is refused, though the owner confirmed", async () => {
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
  const options = { database, toyBoxOrigin: new URL(toyBox.url) };
  const owner = { channelId, at: 1_000 };
  const input = { slackChannel: "C-link" };
  const { confirm } = await linkCommand({ ...options, bot })(input, owner);

  const answer = linkCommand({ ...options, bot: moving })(input, { ...owner, confirmed: confirm });

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

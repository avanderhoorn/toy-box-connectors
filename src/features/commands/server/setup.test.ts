import { expect, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { countRows, createStoredLink, fillEveryTable } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage } from "@slackapi/model/testFixtures";
import { resumeCommand, unlinkCommand } from "./setup";
import { refusal } from "./testFixtures";

test("resume refuses a link Slack gave a new channel ID, before it asks Toy Box or Slack", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", {
    status: "suspended",
    status_reason: "channel_id_changed",
  });
  const resume = resumeCommand({
    database,
    bot: null,
    toyBoxOrigin: new URL("http://127.0.0.1"),
  });

  const answer = resume({}, { channelId: "toybox-link", at: 1_000 });

  expect(await refusal(answer)).toBe(
    "The link to #C-link is suspended because Slack gave its channel a new ID. Run `toy-box-slack unlink`, then have the owner link the channel again by its new ID.",
  );
});

test("unlink deletes what the bridge kept for its link, and nothing of another link's", async () => {
  const database = await openTestDatabase();
  await fillEveryTable(database);
  const before = await countRows(database);
  await createStoredLink(database, "gone");
  const message = askMessage(undefined, { channelId: "C-gone" });
  await createStoredMessage(database, message);
  await createStoredRequest(database, { linkId: "gone", channelId: "C-gone" });
  const unlink = unlinkCommand({
    database,
    bot: null,
    toyBoxOrigin: new URL("http://127.0.0.1"),
  });

  await unlink({}, { channelId: "toybox-gone", at: 1_000 });

  expect(await countRows(database)).toEqual(before);
});

import { expect, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { askMessage, editMessage, replyMessage } from "@slackapi/model/testFixtures";
import { activityCommand, markReadCommand } from "./activity";
import { refusal } from "./testFixtures";

const LEAD = { channelId: "toybox-link", at: 1_700_007_300_000 };

test("serves the messages that changed after the cursor a page at a time, and marks read only what it served", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const elsewhere = askMessage(undefined, { channelId: "C-other" });
  await createStoredMessage(database, elsewhere);
  const ask = askMessage();
  for (const message of [
    ask,
    replyMessage(ask, "1700000200.000100", { userId: "U-carol" }),
    replyMessage(ask, "1700000300.000100", { userId: "U-bot", author: "self", text: "On it." }),
    editMessage(ask, "1700000400.000100", "Can you look at prod instead?"),
    askMessage("1700003700.000100", { userId: "U-allowed" }),
    replyMessage(ask, "1700003800.000100"),
  ]) {
    await createStoredMessage(database, message);
  }
  await database.write((tx) => tx`INSERT INTO users (user_id, real_name) VALUES ('U-bot', 'Toy')`);
  const activity = activityCommand({ database, workspaceUrl: () => "https://acme.slack.com/" });
  const markRead = markReadCommand({ database });

  const first = await activity({ limit: 2 }, LEAD);
  expect(first.text).toBe(
    [
      "Here's what changed in #C-link since you last marked it read.",
      "### Thread started 2 hours ago\nhttps://acme.slack.com/archives/C-link/p1700000100000100",
      "```slack from U-owner (edited)\nCan you look at prod instead?\n```",
      "```slack from Toy (you)\nOn it.\n```",
      "Once you've read these, run `toy-box-slack mark-read --through 5`. Then run activity again for 2 more messages.",
    ].join("\n\n"),
  );
  expect(await refusal(markRead({ through: 6 }, LEAD))).toBe(
    "Activity hasn't shown you change 6, so it isn't marked read. Run `toy-box-slack activity`, then the mark-read it ends with.",
  );
  // Until it's marked read, a digest that didn't finish gets the same page again.
  expect(await activity({ limit: 2 }, LEAD)).toEqual(first);
  expect((await markRead({ through: 5 }, LEAD)).text).toBe("#C-link is read through change 5.");
  expect((await markRead({ through: 4 }, LEAD)).text).toBe("#C-link is read through change 5.");
  expect((await activity({ limit: 2 }, LEAD)).result).toMatchObject({
    threads: [
      { messages: [{ text: "it fails on the migration step" }] },
      { messages: [{ text: "{Toy} can you look at the deploy?" }] },
    ],
    through: 7,
    more: 0,
  });
  await markRead({ through: 7 }, LEAD);
  expect((await activity({ limit: 2 }, LEAD)).text).toBe(
    "Nothing new to read in #C-link since you last marked it read.",
  );
});

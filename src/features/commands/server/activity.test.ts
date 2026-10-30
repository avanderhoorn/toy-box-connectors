import { expect, test } from "bun:test";
import { forgetOldActivity } from "@activity/server/ledger";
import { createStoredMessage } from "@activity/server/testFixtures";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
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
  // Until it's marked read, a digest that didn't finish gets the same page again, even once the
  // ledger forgets the changes later ones replaced.
  await database.write((tx) => forgetOldActivity(tx, LEAD.at));
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

test("names each thread the lead could post in now as post's --thread takes it", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await database.write(
    (tx) => tx`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)`,
  );
  const roots = {
    asked: "1700000100.000100",
    published: "1700000200.000100",
    cancelled: "1700000300.000100",
    denied: "1700000400.000100",
    waiting: "1700000500.000100",
    quiet: "1700000600.000100",
  };
  const answered = (rootTs: string, sourceTs = rootTs) =>
    createStoredRequest(database, { state: "answered", rootTs, sourceTs });
  for (const ts of Object.values(roots)) await createStoredMessage(database, askMessage(ts));
  await answered(roots.asked);
  // The lead's notes started this thread, and someone asked in it.
  await answered(roots.published, "1700000210.000100");
  await createStoredOutboxItem(database, 1, {
    kind: "publication",
    request_id: null,
    thread_ts: null,
    series: "notes",
    scheduled_at: 0,
    state: "sent",
    slack_ts: roots.published,
  });
  await createStoredRequest(database, {
    rootTs: roots.cancelled,
    sourceTs: roots.cancelled,
    state: "cancelled",
    closedReason: "source_deleted",
  });
  await createStoredRequest(database, {
    rootTs: roots.denied,
    sourceTs: roots.denied,
    state: "answered",
    requesterUserId: "U-carol",
  });
  await createStoredRequest(database, {
    rootTs: roots.waiting,
    sourceTs: roots.waiting,
    state: "seen",
  });
  const activity = activityCommand({ database, workspaceUrl: () => null });

  const { result, text } = await activity({ limit: 10 }, LEAD);

  expect(result).toMatchObject({
    threads: [
      { reference: "r1" },
      { reference: "o1" },
      { reference: null },
      { reference: null },
      { reference: null },
      { reference: null },
    ],
  });
  expect(text).toContain("### r1's thread, started 2 hours ago\n\n```slack from U-owner");
  expect(text).toContain("### Thread started 1 hour ago\n\n```slack from U-owner");
});

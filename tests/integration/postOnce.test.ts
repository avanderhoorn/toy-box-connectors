// Nothing the lead asks the bridge to post reaches Slack twice.

import { expect, test } from "bun:test";
import type { FakeSlack } from "../fakes/slack";
import { withDatabase } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, said, timestamps } from "./connectedBridge";
import { waitFor } from "./waitFor";

test("an answer the bridge was posting when it crashed posts once, and the next bridge confirms it", async () => {
  const { slack, dataFolder, inbox, reply, post, crash, stop, saying } = await connectedBridge();
  const [askedTs] = timestamps(1);
  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));
  await inbox();

  // Slack takes the answer, and the bridge dies before it hears back.
  slack.failNext("chat.postMessage", { lostResponse: true });
  expect(await reply(1, "The deploy is fine.")).toMatchObject({ exitCode: 0 });
  await waitFor(() => expect(answers(slack, askedTs)).toHaveLength(1));
  // The next bridge looks in Alice's thread for an interrupted post a minute after it began,
  // instead of posting it again.
  await crash((database) =>
    database.write(
      (transaction) =>
        transaction`UPDATE outbox SET attempt_started_at = attempt_started_at - 60000`,
    ),
  );
  await waitFor(
    () => expect(slack.calls.map(({ method }) => method)).toContain("conversations.replies"),
    5_000,
  );

  expect(await stop()).toEqual({ code: 0, stderr: saying() });
  const [answer] = answers(slack, askedTs);
  expect(slack.calls.filter(({ method }) => method === "chat.postMessage")).toHaveLength(1);
  await withDatabase(dataFolder, async (database) => {
    expect(await database.read((sql) => sql`SELECT state, slack_ts FROM outbox`)).toEqual([
      { state: "sent", slack_ts: answer!.ts },
    ]);
    expect(await database.read((sql) => sql`SELECT state FROM requests`)).toEqual([
      { state: "answered" },
    ]);
  });
}, 15_000);

/** The bot's replies in the thread of the C-link message at `ts`. */
function answers(slack: FakeSlack, ts: string) {
  return slack
    .getMessages("C-link")
    .filter((message) => message.thread_ts === ts && message.user === BOT);
}

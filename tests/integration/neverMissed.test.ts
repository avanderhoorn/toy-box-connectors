// Nothing Slack tells the bot about its channel is silently missed.

import { expect, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import { askMessage } from "@slackapi/model/testFixtures";
import type { SlackTs } from "@slackapi/model/ts";
import { withDatabase } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, posted, said, timestamps } from "./connectedBridge";
import { waitFor } from "./waitFor";

test("an event counts when Slack delivered it to the bot in its workspace, wherever it happened", async () => {
  const { inbox, post, deliver, stop, saying } = await connectedBridge();
  const [siblingTs, appTs, botTs, emptyTs, omittedTs] = timestamps(5);
  const ask = (ts: SlackTs) => said(ALICE, ts, `<@${BOT}> can you check the deploy?`);
  const anotherBot = {
    enterprise_id: null,
    team_id: "T-home",
    user_id: "U0OTHER",
    is_bot: true,
    is_enterprise_install: false,
  };

  // A coworker can post from a sibling workspace in an Enterprise org.
  await post(ask(siblingTs), { teamId: "T-sibling" });
  await deliver(posted(ask(appTs)), { appId: "A-other" });
  await deliver(posted(ask(botTs)), { authorizations: [anotherBot] });
  await deliver(posted(ask(emptyTs)), { authorizations: [] });
  // Without authorizations, the workspace decides.
  await post(ask(omittedTs), { authorizations: undefined });
  // Our bot can see another workspace's uninstall, which isn't ours.
  await deliver({ type: "app_uninstalled" }, { teamId: "T-other" });

  expect(await inbox()).toMatchObject({
    requests: [{ messages: [{ ts: siblingTs }] }, { messages: [{ ts: omittedTs }] }],
  });
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
}, 15_000);

test("a request the bridge acked survives a crash, and the next bridge wakes the lead for it", async () => {
  // The first bridge would wait a minute to wake the lead, so it crashes before it does.
  const { toyBox, inbox, post, crash, stop, saying } = await connectedBridge({
    wakes: { debounce: 60_000, debounceLimit: 60_000 },
  });
  const [askedTs] = timestamps(1);

  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));
  await crash();

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  expect(await inbox()).toMatchObject({
    requests: [{ id: 1, requester: { userId: ALICE }, messages: [{ ts: askedTs }] }],
  });
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
}, 15_000);

test("what Slack kept while the bridge was down reaches the lead once it's back, from the link on", async () => {
  const [threadTs] = timestamps(1, Date.now() - 600_000);
  const [beforeTs, linkedTs, askedTs, editedTs, repliedTs, missedTs, followedTs] = timestamps(7);
  const { slack, toyBox, dataFolder, inbox, post, crash, stop, saying } = await connectedBridge({
    link: { linked_at_ts: linkedTs },
  });
  const asked = said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`);
  await post(asked);
  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  await inbox();

  // Slack sends the bridge no event for these, as if it were down. The first two came before the
  // link, and the last replies in the first's thread.
  slack.setMessage("C-link", said(ALICE, threadTs, "Is staging up?"));
  slack.setMessage("C-link", said(ALICE, beforeTs, `<@${BOT}> is staging up?`));
  slack.setMessage("C-link", {
    ...asked,
    text: `<@${BOT}> can you check the deploy to prod?`,
    edited: { user: ALICE, ts: editedTs },
  });
  slack.setMessage("C-link", said(ALICE, repliedTs, "It's the 2pm one.", { thread_ts: askedTs }));
  slack.setMessage("C-link", said(ALICE, missedTs, `<@${BOT}> and the release notes?`));
  slack.setMessage("C-link", said(ALICE, followedTs, "It's up now.", { thread_ts: threadTs }));
  // The fixture's message is from 2023, long past the 30 days the ledger keeps one.
  await crash((database) => createStoredMessage(database, askMessage()));

  await waitFor(() => expect(toyBox.runs).toHaveLength(2), 5_000);
  expect(await inbox()).toMatchObject({
    requests: [
      { id: 1, attention: "updated", messages: [{ ts: askedTs, edited: true }, { ts: repliedTs }] },
      { id: 2, messages: [{ ts: missedTs }] },
    ],
  });
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
  // Catch-up stores nothing from before the link, so activity never shows it to the lead either,
  // and the bridge forgot the old message as it started.
  const stored = await withDatabase(dataFolder, (database) =>
    database.read((sql) => sql`SELECT ts FROM messages ORDER BY ts`),
  );
  expect(stored).toEqual([askedTs, repliedTs, missedTs, followedTs].map((ts) => ({ ts })));
}, 15_000);

test("catching up waits out a rate limit, and stores a channel only once it has read all of it", async () => {
  const { slack, toyBox, inbox, status, stop, saying } = await connectedBridge({
    wakes: { debounce: 50, debounceLimit: 200, retry: 1_000, retryLimit: 1_000 },
  });
  const histories = () => slack.calls.filter(({ method }) => method === "conversations.history");
  await waitFor(() => expect(histories()).toHaveLength(1));
  const [rootTs, repliedTs, missedTs] = timestamps(3);
  slack.setMessage("C-link", said(ALICE, rootTs, "The deploy is stuck."));
  slack.setMessage(
    "C-link",
    said(ALICE, repliedTs, `<@${BOT}> can you look?`, { thread_ts: rootTs }),
  );
  slack.setMessage("C-link", said(ALICE, missedTs, `<@${BOT}> and the release notes?`));
  slack.failNext("conversations.history", { retryAfter: 1 });
  slack.failNext("conversations.replies", { error: "internal_error" });
  slack.disconnect();

  const refused = "Slack refused conversations.replies with internal_error.";
  const problem = `Can't catch up on messages the bridge may have missed. ${refused}`;
  await waitFor(
    async () => expect((await status(null)).json).toMatchObject({ slack: { problem } }),
    5_000,
  );
  // The run Slack refused stored nothing, so the lead never sees half of what it missed.
  expect((await inbox()).requests).toEqual([]);
  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  expect(await inbox()).toMatchObject({
    requests: [
      { id: 1, messages: [{ ts: rootTs }, { ts: repliedTs }] },
      { id: 2, messages: [{ ts: missedTs }] },
    ],
  });
  const [, limited, waited] = histories();
  expect(waited!.at - limited!.at).toBeGreaterThanOrEqual(1_000);
  expect(await stop()).toEqual({
    code: 0,
    stderr: saying(
      "Slack ended the connection with refresh_requested, so the bridge is reconnecting.",
      "Connected to Slack.",
      problem,
      "Caught up on messages the bridge may have missed.",
    ),
  });
}, 15_000);

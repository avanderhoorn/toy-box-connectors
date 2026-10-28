// Nothing Slack tells the bot about its channel is silently missed.

import { expect, test } from "bun:test";
import type { SlackTs } from "@slackapi/model/ts";
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

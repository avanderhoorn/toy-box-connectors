// An owner's Approve click on a running bridge, and what it sets in motion across the bridge's
// parts: the applier, the Toy Box follower, the wakes and the Slack supervisor.

import { expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder } from "@bridge/server/testFixtures";
import { APPROVE_ACTION_ID, type Approval } from "@links/model/approvals";
import type { SetupRequest } from "@links/model/setup";
import { recordCardPosted } from "@links/server/approvals";
import { createFactsReader } from "@links/server/facts";
import { changeSetup } from "@links/server/setup";
import { createStoredLink } from "@links/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { routineTemplates } from "@toybox/model/routines";
import type { FakeSlack } from "../fakes/slack";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge, startSlackForBridge } from "./bridgeProcess";
import { waitFor } from "./waitFor";

const CARD_TS = "1000.000100";

/** A full member of the installation's workspace, as users.info shows them. */
function member(id: string) {
  return {
    id,
    team_id: "T-home",
    real_name: `${id} Person`,
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
  };
}

/**
 * A data folder holding the installation U-owner owns, and a fake Toy Box channel whose owner just
 * asked its lead to set up Slack, linked to C-link when `linked` is set. C-link is a private
 * channel of the fake Slack's workspace with the owner and the bot in it, and U-carol is a full
 * member. `env` points a bridge at the fakes.
 */
async function ownedChannel({ linked }: { linked: boolean }) {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, routineTemplates.requests);
  toyBox.postOwnerMessage(channelId, "Let Carol ask you things in #release-eng.");
  // The fake's workspace and app are the stored installation's.
  const { slack, env } = startSlackForBridge({
    teamId: "T-home",
    appId: "A-app",
    botId: "B-bot",
    botUserId: "U-bot",
  });
  slack.addChannel({
    id: "C-link",
    name: "release-eng",
    is_private: true,
    members: ["U-bot", "U-owner"],
  });
  slack.setUser(member("U-carol"));
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  await withDatabase(dataFolder, async (database) => {
    await createStoredInstallation(database);
    if (linked) {
      await createStoredLink(database, "link", {
        toybox_channel_id: channelId,
        requests_routine_id: routine.id,
      });
    }
  });

  /** Has the channel's lead propose `request` while no bridge runs, and posts its card. */
  function propose(request: SetupRequest): Promise<Approval> {
    return withDatabase(dataFolder, async (database) => {
      const bot = createBotClient(database, slack.botToken, { slackApiUrl: slack.url });
      const reader = createFactsReader(bot, new URL(toyBox.url));
      const lead = { role: "lead", channelId } as const;
      const outcome = await changeSetup(database, reader, lead, request, true, Date.now());
      if (outcome.kind !== "proposed") {
        throw new Error(`Setup was ${outcome.kind}, not a proposal.`);
      }
      await database.write((transaction) =>
        recordCardPosted(transaction, outcome.approval.id, CARD_TS),
      );
      return outcome.approval;
    });
  }

  return {
    toyBox,
    slack,
    channelId,
    routineId: routine.id,
    home,
    dataFolder,
    env: { TOY_BOX_URL: toyBox.url, ...env },
    propose,
  };
}

/** Opens the data folder's database for `use` while no bridge holds it. */
async function withDatabase<T>(dataFolder: string, use: (database: BridgeDatabase) => Promise<T>) {
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    return await use(database);
  } finally {
    await database.close();
  }
}

/** Has the owner click Approve on `approval`'s card, and waits for the bridge to ack it. */
async function approve(slack: FakeSlack, approval: Approval) {
  // Slack says hello as a connection opens, so the click reaches the bridge after it.
  await waitFor(() => expect(slack.activeConnections).toBe(1), 5_000);
  const click = slack.sendInteraction({
    type: "block_actions",
    api_app_id: "A-app",
    team: { id: "T-home", domain: "home" },
    user: { id: "U-owner", username: "owner", team_id: "T-home" },
    trigger_id: "1.2.3",
    container: {
      type: "message",
      message_ts: CARD_TS,
      channel_id: approval.card.channelId,
      is_ephemeral: false,
    },
    actions: [
      {
        type: "button",
        action_id: APPROVE_ACTION_ID,
        block_id: "decide",
        value: approval.id,
        action_ts: "1000.900000",
      },
    ],
  });
  expect(await slack.waitForAck(click.envelopeId, 5_000)).not.toBeNull();
}

test("a link the owner approves on a running bridge is applied, followed, and its lead woken", async () => {
  const { toyBox, slack, channelId, routineId, home, dataFolder, env, propose } =
    await ownedChannel({ linked: false });
  const approval = await propose({
    action: "link",
    slackChannelId: "C-link",
    routineId,
    allow: ["U-carol"],
  });
  const bridge = spawnBridge(home, env);
  await bridge.running();

  await approve(slack, approval);

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  // The checks' own reads close, leaving the bridge following the channel it linked.
  await waitFor(() => expect(toyBox.connections(channelId)).toBe(1));
  bridge.child.kill("SIGTERM");
  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `toy-box-slack is running for ${dataFolder}\ntoy-box-slack is stopping after SIGTERM\n`,
  });
  expect(toyBox.runs).toMatchObject([{ channelId, routineId, by: "api" }]);
  await withDatabase(dataFolder, async (database) => {
    expect(
      await database.read(
        (sql) => sql`SELECT toybox_channel_id, slack_channel_id, status FROM links`,
      ),
    ).toEqual([{ toybox_channel_id: channelId, slack_channel_id: "C-link", status: "active" }]);
    expect(await database.read((sql) => sql`SELECT state FROM approvals`)).toEqual([
      { state: "applied" },
    ]);
    expect(await database.read((sql) => sql`SELECT kind, approval_id, outcome FROM wakes`)).toEqual(
      [{ kind: "setup", approval_id: approval.id, outcome: "ran" }],
    );
  });
}, 15_000);

test("a change the owner approves to a running bridge's link wakes its lead once it applies", async () => {
  const { toyBox, slack, channelId, routineId, home, dataFolder, env, propose } =
    await ownedChannel({ linked: true });
  const approval = await propose({ action: "allow", userIds: ["U-carol"] });
  const bridge = spawnBridge(home, env);
  await bridge.running();

  await approve(slack, approval);

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  bridge.child.kill("SIGTERM");
  expect((await bridge.exit()).code).toBe(0);
  expect(toyBox.runs).toMatchObject([{ channelId, routineId, by: "api" }]);
  await withDatabase(dataFolder, async (database) => {
    expect(await database.read((sql) => sql`SELECT user_id FROM allowlist`)).toEqual([
      { user_id: "U-carol" },
    ]);
    expect(
      await database.read((sql) => sql`SELECT link_id, kind, approval_id, outcome FROM wakes`),
    ).toEqual([{ link_id: "link", kind: "setup", approval_id: approval.id, outcome: "ran" }]);
  });
}, 15_000);

test("Slack rejecting the bot token while a change is checked has the bridge confirm it again", async () => {
  const { slack, home, dataFolder, env, propose } = await ownedChannel({ linked: true });
  const approval = await propose({ action: "allow", userIds: ["U-carol"] });
  const bridge = spawnBridge(home, env);
  await bridge.running();
  const authTests = () => slack.calls.filter(({ method }) => method === "auth.test");
  slack.failNext("conversations.info", { error: "invalid_auth" });

  await approve(slack, approval);

  await waitFor(() => expect(authTests()).toHaveLength(2), 5_000);
  bridge.child.kill("SIGTERM");
  const { code, stderr } = await bridge.exit();
  expect(code).toBe(0);
  expect(stderr).toContain("Slack rejected SLACK_BOT_TOKEN with invalid_auth.");
  expect(authTests()).toHaveLength(2);
  // Confirming the token again ends auth_failed, and the time it lasted becomes a gap to repair.
  await withDatabase(dataFolder, async (database) => {
    expect(await database.read((sql) => sql`SELECT status FROM installation`)).toEqual([
      { status: "active" },
    ]);
    expect(
      await database.read(
        (sql) => sql`SELECT channel_id FROM coverage WHERE reason = 'auth_failed'`,
      ),
    ).toEqual([{ channel_id: "C-link" }]);
  });
}, 15_000);

// One bridge hosting several apps, each answering through a Slack app of its own.

import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import type { BridgeDatabase } from "@bridge/server/database";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { createAddedApp, createTestFolder } from "@bridge/server/testFixtures";
import { callBridge, type CallOptions } from "@commands/client/cli";
import { createStoredLink } from "@links/server/testFixtures";
import { refusalProblem } from "@slackapi/model/identity";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import type { FakeSlack, FakeSlackApp, FakeSlackChannel } from "../fakes/slack";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge, started, startSlackForBridge, withDatabase } from "./bridgeProcess";
import { ALICE, BOT, PROMPTLY, posted, said, timestamps } from "./connectedBridge";
import { REQUESTS_ROUTINE } from "./linkedBridge";
import { waitFor } from "./waitFor";

/** The Slack app the installation fixture records. */
const RECORDED = { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" };

const STOPPING = "toy-box-slack is stopping after SIGTERM\n";

/** The releases app's bot, which shares C-link with the default app's. */
const RELEASES_BOT = "U0RELBOT";

/** A home folder with a data folder the bridge hasn't started in yet. */
function prepareHome() {
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  return { home, dataFolder };
}

/** The lines of a credentials.env holding `app`'s two tokens. */
function tokensOf(app: Pick<FakeSlackApp, "botToken" | "appToken">) {
  return { SLACK_BOT_TOKEN: app.botToken, SLACK_APP_TOKEN: app.appToken };
}

/** Sends `app` a message in C-link the way Slack does, and waits for a bridge to ack it. */
async function deliverTo(app: Pick<FakeSlackApp, "sendEvent" | "waitForAck">) {
  const [ts] = timestamps(1);
  const { envelopeId } = app.sendEvent(posted(said(ALICE, ts!, "Is the release out?")));
  expect(await app.waitForAck(envelopeId, 5_000)).not.toBeNull();
}

/**
 * Checks that a bridge for `home` said `lines` between starting and stopping, in any order, since
 * each app says its own.
 */
function expectSaid(stderr: string, home: string, lines: readonly string[]) {
  expect(stderr).toStartWith(started(home));
  expect(stderr).toEndWith(STOPPING);
  const between = stderr.slice(started(home).length, -STOPPING.length).trimEnd().split("\n");
  expect(between.toSorted()).toEqual(lines.toSorted());
}

/** The installation the app keeping its files in `folder` records, once no bridge runs. */
function installationIn(folder: string) {
  return withDatabase(folder, (database) => database.read(readInstallation));
}

/** `line` as a bridge logs it for `app`. */
function logged(app: string, line: string) {
  return app === "default" ? line : `[${app}] ${line}`;
}

/** A home whose default app and releases app both hold the tokens of `slack`'s one Slack app. */
function prepareTwoAppsOfOne(slack: FakeSlackApp) {
  const { home, dataFolder } = prepareHome();
  const releases = createAddedApp(dataFolder, "releases", tokensOf(slack));
  const folders: Record<string, string> = { default: dataFolder, releases: releases.folder };
  return { home, folders };
}

describe("a Slack app the tokens of two apps belong to", () => {
  // The default app usually asks Slack first, so only the releases app holding the record proves
  // the record decides.
  test("stays with the releases app whose bridge.db records it, so the other never connects", async () => {
    const { slack, env } = startSlackForBridge(RECORDED);
    const { home, folders } = prepareTwoAppsOfOne(slack);
    await withDatabase(folders.releases!, (database) => createStoredInstallation(database));
    const connected = logged("releases", "Connected to Slack.");
    const refused = logged(
      "default",
      refusalProblem({ reason: "duplicate_app", heldBy: "releases" }, "default"),
    );

    const bridge = spawnBridge(home, env);
    await bridge.says(refused);
    await bridge.says(connected);
    await deliverTo(slack);

    expect(slack.connections).toHaveLength(1);
    bridge.child.kill("SIGTERM");
    const { code, stderr } = await bridge.exit();
    expect(code).toBe(0);
    expectSaid(stderr, home, [connected, refused]);
    expect(await installationIn(folders.default!)).toBeNull();
  }, 15_000);

  test("goes to whichever app Slack confirms first when no bridge.db records it, and the other never connects", async () => {
    const { slack, env } = startSlackForBridge(RECORDED);
    const { home, folders } = prepareTwoAppsOfOne(slack);

    const bridge = spawnBridge(home, env);
    await bridge.says("Connected to Slack.");
    await bridge.says("belongs to the same Slack app as the");
    await deliverTo(slack);

    expect(slack.connections).toHaveLength(1);
    bridge.child.kill("SIGTERM");
    const { code, stderr } = await bridge.exit();
    expect(code).toBe(0);
    // Both apps ask Slack at once, so either may be first.
    const [holder, other] = stderr.includes("[releases] Connected to Slack.")
      ? ["releases", "default"]
      : ["default", "releases"];
    const refused = refusalProblem({ reason: "duplicate_app", heldBy: holder }, other);
    expectSaid(stderr, home, [logged(holder, "Connected to Slack."), logged(other, refused)]);
    expect(await installationIn(folders[holder]!)).toMatchObject({ appId: RECORDED.appId });
    expect(await installationIn(folders[other]!)).toBeNull();
  }, 15_000);
});

test("a bridge that hosts only the default app names no app in what link says", async () => {
  const { slack, env } = startSlackForBridge(RECORDED);
  slack.addChannel({ id: "C0RELEASES", name: "releases" });
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const docs = toyBox.addChannel({ name: "Docs" });
  const { home } = prepareHome();
  const bridge = spawnBridge(home, { ...env, TOY_BOX_URL: toyBox.url });
  await bridge.says("Connected to Slack.");

  const linked = await callBridge(
    "link",
    { slackChannel: "C0RELEASES" },
    { channelId: docs, env: {}, home },
  );
  expect(linked).toMatchObject({ exitCode: 0 });
  expect(linked.text).toStartWith(
    'The lead of "Docs" answers in #releases now, for the people `toy-box-slack allow` names.\n',
  );

  bridge.child.kill("SIGTERM");
  const { code, stderr } = await bridge.exit();
  expect(code).toBe(0);
  expectSaid(stderr, home, ["Connected to Slack."]);
}, 15_000);

/**
 * A bridge hosting the default app and releases, each through its own Slack app in one workspace,
 * whose bots are both in C-link, a private channel Alice is in. Toy Box has a channel for each
 * lead, Docs and Releases, each with the requests routine. `prepare` changes each app's bridge.db
 * before the bridge opens it.
 */
async function startSharedChannel(
  prepare: (apps: {
    home: BridgeDatabase;
    releases: BridgeDatabase;
    leads: { docs: string; releases: string };
  }) => Promise<unknown> = async () => {},
) {
  const { slack, env } = startSlackForBridge({ ...RECORDED, botUserId: BOT });
  const releasesSlack = slack.addApp({ botUserId: RELEASES_BOT });
  /** Seeds `channel`, a private one, in Slack with both apps' bots in it. */
  const share = (channel: FakeSlackChannel) => {
    for (const app of [slack, releasesSlack]) app.addChannel({ is_private: true, ...channel });
  };
  share({ id: "C-link", name: "release-eng", members: [BOT, RELEASES_BOT, ALICE] });
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const leads = {
    docs: toyBox.addChannel({ name: "Docs" }),
    releases: toyBox.addChannel({ name: "Releases" }),
  };
  for (const lead of Object.values(leads)) toyBox.scheduleRoutine(lead, REQUESTS_ROUTINE);
  const { home, dataFolder } = prepareHome();
  const releases = createAddedApp(dataFolder, "releases", tokensOf(releasesSlack));
  await withDatabase(dataFolder, (homeDatabase) =>
    withDatabase(releases.folder, (releasesDatabase) =>
      prepare({ home: homeDatabase, releases: releasesDatabase, leads }),
    ),
  );

  const bridge = spawnBridge(home, {
    ...env,
    TOY_BOX_URL: toyBox.url,
    TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify(PROMPTLY),
  });
  await bridge.says("[releases] Connected to Slack.");
  // Only the default app's line starts with it.
  await bridge.says("\nConnected to Slack.");

  /** Calls `name` the way the CLI does, as the lead of `lead`, or at a terminal when it's null. */
  const as = (
    lead: string | null,
    name: string,
    input: Record<string, unknown> = {},
    options: CallOptions = {},
  ) =>
    callBridge(name, input, {
      env: { COPILOT_AGENT_SESSION_ID: lead ?? undefined },
      home,
      ...options,
    });

  /** Delivers a channel event, waiting until both apps have committed and acked it. */
  const deliver = async (event: Record<string, unknown>) => {
    const deliveries = slack.broadcastEvent(event);
    expect(deliveries.map(({ appId }) => appId)).toEqual([
      RECORDED.appId,
      releasesSlack.identity.appId,
    ]);
    for (const { appId, envelopeId } of deliveries) {
      const app = appId === RECORDED.appId ? slack : releasesSlack;
      expect(await app.waitForAck(envelopeId, 5_000)).not.toBeNull();
    }
  };

  return {
    slack,
    releasesSlack,
    leads,
    dataFolder,
    releasesFolder: releases.folder,
    share,
    as,
    deliver,
    /** Stops the bridge, and checks it said only that both apps connected. */
    stop: async () => {
      bridge.child.kill("SIGTERM");
      const { code, stderr } = await bridge.exit();
      expect(code).toBe(0);
      expectSaid(stderr, home, ["Connected to Slack.", "[releases] Connected to Slack."]);
    },
  };
}

/** Links `lead` to C-link in `database` and allows Alice there. */
async function linkLead(database: BridgeDatabase, lead: string) {
  await createStoredLink(database, "link", { toybox_channel_id: lead });
  await database.write(
    (transaction) => transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', ${ALICE}, 0)
    `,
  );
}

/** What `app`'s bot posted in Slack. */
function postsBy(app: Pick<FakeSlack, "calls">) {
  return app.calls.filter(({ method }) => method === "chat.postMessage");
}

describe("two leads that share a Slack channel, each through its own app", () => {
  test("the owner can link two Toy Box channels to one Slack channel through different apps, each answering as its app's bot", async () => {
    const shared = await startSharedChannel();
    const { leads, as } = shared;
    const channel = "C0SHARED";
    shared.share({ id: channel, name: "shared" });
    for (const [lead, app] of [
      [leads.docs, "default"],
      [leads.releases, "releases"],
    ] as const) {
      const input = { slackChannel: channel, app };
      expect(await as(null, "link", input, { channelId: lead })).toMatchObject({
        exitCode: 0,
        text: expect.stringContaining(`answers in #shared now as the ${app} app's bot,`),
      });
    }
    await shared.stop();
    for (const [folder, lead] of [
      [shared.dataFolder, leads.docs],
      [shared.releasesFolder, leads.releases],
    ] as const)
      expect(
        await withDatabase(folder, (database) =>
          database.read((sql) => sql`SELECT toybox_channel_id, slack_channel_id FROM links`),
        ),
      ).toEqual([{ toybox_channel_id: lead, slack_channel_id: channel }]);
  }, 15_000);

  test("one bot leaving suspends only its app's link while the other lead keeps answering", async () => {
    const shared = await startSharedChannel(async ({ home, releases, leads }) => {
      await linkLead(home, leads.docs);
      await linkLead(releases, leads.releases);
    });
    const { slack, releasesSlack, leads, as, deliver } = shared;
    // Startup's history read must not discover the removal instead of the membership event.
    await waitFor(() => {
      for (const app of [slack, releasesSlack])
        expect(app.calls.some(({ method }) => method === "conversations.history")).toBe(true);
    }, 5_000);
    releasesSlack.addChannel({ id: "C-link", is_member: false });
    await deliver({
      type: "member_left_channel",
      channel: "C-link",
      user: RELEASES_BOT,
      team: RECORDED.teamId,
    });
    expect((await as(leads.docs, "status")).json).toMatchObject({
      apps: [{ app: "default", links: [{ status: "active", statusReason: null }] }],
    });
    expect((await as(leads.releases, "status")).json).toMatchObject({
      apps: [{ app: "releases", links: [{ status: "suspended", statusReason: "bot_removed" }] }],
    });
    const [askedTs] = timestamps(1);
    const message = said(ALICE, askedTs!, `<@${BOT}> are the docs ready?`);
    slack.setMessage("C-link", message);
    const deliveries = slack.broadcastEvent(posted(message));
    expect(deliveries.map(({ appId }) => appId)).toEqual([slack.identity.appId]);
    expect(await slack.waitForAck(deliveries[0]!.envelopeId, 5_000)).not.toBeNull();
    expect((await as(leads.docs, "inbox")).json).toMatchObject({
      requests: [{ id: 1, messages: [{ ts: askedTs }] }],
    });
    expect(
      await as(leads.docs, "reply", { request: "r1", text: "The docs are ready." }),
    ).toMatchObject({
      exitCode: 0,
    });
    await waitFor(
      () =>
        expect(
          slack.getMessages("C-link").filter(({ bot_id }) => bot_id === slack.identity.botId),
        ).toHaveLength(1),
      5_000,
    );
    expect(postsBy(slack)).toHaveLength(1);
    expect(postsBy(releasesSlack)).toEqual([]);
    await shared.stop();
  }, 15_000);
});

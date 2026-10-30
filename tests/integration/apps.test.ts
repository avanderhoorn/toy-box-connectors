// One bridge hosting several apps, each answering through a Slack app of its own.

import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import type { BridgeDatabase } from "@bridge/server/database";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { createAddedApp, createTestFolder } from "@bridge/server/testFixtures";
import { callBridge, type CallOptions } from "@commands/client/cli";
import { createStoredLink } from "@links/server/testFixtures";
import { refusalProblem, rejectedTokensProblem } from "@slackapi/model/identity";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import type { FakeSlack, FakeSlackApp, FakeSlackChannel, FakeSlackMessage } from "../fakes/slack";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge, started, startSlackForBridge, withDatabase } from "./bridgeProcess";
import { ALICE, BOT, PROMPTLY, posted, said, timestamps } from "./connectedBridge";
import { REQUESTS_ROUTINE, type LinkColumns } from "./linkedBridge";
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

describe("a Slack app the tokens of two apps belong to", () => {
  test("stays with the default app whose bridge.db records it, so the added app never connects", async () => {
    const { slack, env } = startSlackForBridge(RECORDED);
    const { home, dataFolder } = prepareHome();
    await withDatabase(dataFolder, (database) => createStoredInstallation(database));
    const releases = createAddedApp(dataFolder, "releases", tokensOf(slack));
    const refused = refusalProblem({ reason: "duplicate_app", heldBy: "default" }, "releases");

    const bridge = spawnBridge(home, env);
    await bridge.says(`[releases] ${refused}`);
    await bridge.says("Connected to Slack.");
    await deliverTo(slack);

    expect(slack.connections).toHaveLength(1);
    bridge.child.kill("SIGTERM");
    const { code, stderr } = await bridge.exit();
    expect(code).toBe(0);
    expectSaid(stderr, home, ["Connected to Slack.", `[releases] ${refused}`]);
    expect(await installationIn(releases.folder)).toBeNull();
  }, 15_000);

  test("stays with an added app whose bridge.db records it, though the default app starts first", async () => {
    const { slack, env } = startSlackForBridge(RECORDED);
    const { home, dataFolder } = prepareHome();
    const releases = createAddedApp(dataFolder, "releases", tokensOf(slack));
    await withDatabase(releases.folder, (database) => createStoredInstallation(database));
    const refused = refusalProblem({ reason: "duplicate_app", heldBy: "releases" }, "default");

    const bridge = spawnBridge(home, env);
    await bridge.says(refused);
    await bridge.says("[releases] Connected to Slack.");
    await deliverTo(slack);

    expect(slack.connections).toHaveLength(1);
    bridge.child.kill("SIGTERM");
    const { code, stderr } = await bridge.exit();
    expect(code).toBe(0);
    expectSaid(stderr, home, ["[releases] Connected to Slack.", refused]);
    expect(await installationIn(dataFolder)).toBeNull();
  }, 15_000);

  test("goes to whichever app Slack confirms first when no bridge.db records it, and the other never connects", async () => {
    const { slack, env } = startSlackForBridge(RECORDED);
    const { home, dataFolder } = prepareHome();
    const releases = createAddedApp(dataFolder, "releases", tokensOf(slack));
    const folders: Record<string, string> = { default: dataFolder, releases: releases.folder };

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
    const said = (app: string, line: string) => (app === "default" ? line : `[${app}] ${line}`);
    const refused = refusalProblem({ reason: "duplicate_app", heldBy: holder }, other);
    expectSaid(stderr, home, [said(holder, "Connected to Slack."), said(other, refused)]);
    expect(await installationIn(folders[holder]!)).toMatchObject({ appId: RECORDED.appId });
    expect(await installationIn(folders[other]!)).toBeNull();
  }, 15_000);
});

test("an added app whose bot token Slack rejects says so, while the default app keeps working", async () => {
  const { slack, env } = startSlackForBridge(RECORDED);
  const releasesSlack = slack.addApp();
  releasesSlack.failNext("auth.test", { error: "token_revoked" });
  const { home, dataFolder } = prepareHome();
  createAddedApp(dataFolder, "releases", tokensOf(releasesSlack));
  const rejected = rejectedTokensProblem([["SLACK_BOT_TOKEN", "token_revoked"]], "releases");

  const bridge = spawnBridge(home, env);
  await bridge.says(`[releases] ${rejected}`);
  await bridge.says("Connected to Slack.");
  await deliverTo(slack);

  expect(releasesSlack.connections).toEqual([]);
  bridge.child.kill("SIGTERM");
  const { code, stderr } = await bridge.exit();
  expect(code).toBe(0);
  expectSaid(stderr, home, ["Connected to Slack.", `[releases] ${rejected}`]);
}, 15_000);

test("a restart starts an app added while the bridge ran, through its own Slack app", async () => {
  const { slack, env } = startSlackForBridge(RECORDED);
  const releasesSlack = slack.addApp();
  const { home, dataFolder } = prepareHome();
  const first = spawnBridge(home, env);
  await first.says("Connected to Slack.");
  const releases = createAddedApp(dataFolder, "releases", tokensOf(releasesSlack));
  first.child.kill("SIGTERM");
  expectSaid((await first.exit()).stderr, home, ["Connected to Slack."]);
  expect(releasesSlack.calls).toEqual([]);

  const next = spawnBridge(home, env);
  await next.says("[releases] Connected to Slack.");
  // Only the default app's line starts with it.
  await next.says("\nConnected to Slack.");
  await deliverTo(releasesSlack);

  next.child.kill("SIGTERM");
  const { code, stderr } = await next.exit();
  expect(code).toBe(0);
  expectSaid(stderr, home, ["Connected to Slack.", "[releases] Connected to Slack."]);
  expect(await installationIn(releases.folder)).toMatchObject({
    appId: releasesSlack.identity.appId,
  });
}, 15_000);

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
    toyBox,
    leads,
    dataFolder,
    releasesFolder: releases.folder,
    share,
    as,
    deliver,
    /** Posts `message` in C-link, and waits for both apps to ack its event, once each stored it. */
    post: async (message: FakeSlackMessage) => {
      slack.setMessage("C-link", message);
      await deliver(posted(message));
    },
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
async function linkLead(database: BridgeDatabase, lead: string, settings: LinkColumns = {}) {
  await createStoredLink(database, "link", { ...settings, toybox_channel_id: lead });
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
  test("the owner can link two Toy Box channels to one Slack channel through different apps", async () => {
    const shared = await startSharedChannel();
    const { leads, as } = shared;
    const channel = "C0SHARED";
    shared.share({ id: channel, name: "shared" });
    for (const [lead, app] of [
      [leads.docs, "default"],
      [leads.releases, "releases"],
    ] as const) {
      const input = { slackChannel: channel, app };
      expect(await as(null, "link", input, { channelId: lead })).toMatchObject({ exitCode: 0 });
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

  test.each(["mention", "all"] as const)(
    "mentions reach only the named lead when both links use %s mode",
    async (requestMode) => {
      const shared = await startSharedChannel(async ({ home, releases, leads }) => {
        await linkLead(home, leads.docs, { request_mode: requestMode });
        await linkLead(releases, leads.releases, { request_mode: requestMode });
      });
      const { toyBox, leads, as, post } = shared;
      const [docsTs, releasesTs] = timestamps(2);

      await post(said(ALICE, docsTs!, `<@${BOT}> are the docs ready?`));
      await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
      expect((await as(leads.docs, "inbox")).json).toMatchObject({
        requests: [{ id: 1, messages: [{ ts: docsTs }] }],
      });
      expect((await as(leads.releases, "inbox")).json).toMatchObject({ requests: [] });

      await post(said(ALICE, releasesTs!, `<@${RELEASES_BOT}> is the release ready?`));
      await waitFor(() => expect(toyBox.runs).toHaveLength(2), 5_000);
      expect((await as(leads.docs, "inbox")).json).toMatchObject({
        requests: [{ id: 1, attention: null, messages: [{ ts: docsTs }] }],
      });
      expect((await as(leads.releases, "inbox")).json).toMatchObject({
        requests: [{ id: 1, messages: [{ ts: releasesTs }] }],
      });
      expect(toyBox.runs.map(({ channelId }) => channelId)).toEqual([leads.docs, leads.releases]);
      await shared.stop();
    },
    15_000,
  );

  test("each bot posts as itself, and the other lead never reads or acts on its text", async () => {
    const shared = await startSharedChannel(async ({ home, releases, leads }) => {
      await linkLead(home, leads.docs, { observe: "channel" });
      await linkLead(releases, leads.releases, { observe: "channel" });
    });
    const { slack, releasesSlack, toyBox, leads, as, post } = shared;
    const [askedTs] = timestamps(1);
    await post(said(ALICE, askedTs!, `<@${BOT}> <@${RELEASES_BOT}> is everything ready?`));
    await waitFor(() => expect(toyBox.runs).toHaveLength(2), 5_000);
    for (const lead of Object.values(leads))
      expect((await as(lead, "inbox")).json).toMatchObject({
        requests: [{ id: 1, messages: [{ ts: askedTs }] }],
      });

    const reply = async (lead: string, text: string) => {
      const before = { docs: slack.acks.length, releases: releasesSlack.acks.length };
      expect(await as(lead, "reply", { request: "r1", text })).toMatchObject({ exitCode: 0 });
      await waitFor(() => {
        expect(slack.acks).toHaveLength(before.docs + 1);
        expect(releasesSlack.acks).toHaveLength(before.releases + 1);
      }, 5_000);
    };
    await reply(leads.docs, `<@${RELEASES_BOT}> the docs are ready.`);
    expect((await as(leads.releases, "inbox")).json).toMatchObject({
      requests: [{ id: 1, attention: null, messages: [{ ts: askedTs }] }],
    });
    await reply(leads.releases, `<@${BOT}> the release is ready.`);
    for (const lead of Object.values(leads))
      expect((await as(lead, "inbox")).json).toMatchObject({ requests: [] });

    const botPosts = slack.getMessages("C-link").filter(({ bot_id }) => bot_id !== undefined);
    expect(botPosts).toHaveLength(2);
    for (const app of [slack, releasesSlack]) {
      expect(postsBy(app)).toHaveLength(1);
      expect(postsBy(app)[0]).toMatchObject({
        token: app.botToken,
        args: { channel: "C-link", thread_ts: askedTs },
      });
      expect(botPosts.find(({ bot_id }) => bot_id === app.identity.botId)).toMatchObject({
        user: app.identity.botUserId,
        app_id: app.identity.appId,
        thread_ts: askedTs,
      });
    }
    expect(toyBox.runs).toHaveLength(2);
    await shared.stop();

    for (const [folder, own] of [
      [shared.dataFolder, slack],
      [shared.releasesFolder, releasesSlack],
    ] as const) {
      const stored = await withDatabase(folder, (database) =>
        database.read(
          (sql) => sql`
            SELECT ts, author_role, user_id, text FROM messages
            WHERE ts <> ${askedTs} ORDER BY ts
          `,
        ),
      );
      expect(stored).toEqual(
        botPosts.map((message) => ({
          ts: message.ts,
          author_role: message.bot_id === own.identity.botId ? "self" : "other",
          user_id: message.bot_id === own.identity.botId ? own.identity.botUserId : null,
          text: message.bot_id === own.identity.botId ? message.text : null,
        })),
      );
      expect(
        await withDatabase(folder, (database) =>
          database.read((sql) => sql`SELECT state FROM requests ORDER BY id`),
        ),
      ).toEqual([{ state: "answered" }]);
    }
  }, 15_000);

  test("a named thread follow-up changes only that lead's request, and an unmentioned one changes both", async () => {
    const shared = await startSharedChannel(async ({ home, releases, leads }) => {
      await linkLead(home, leads.docs);
      await linkLead(releases, leads.releases);
    });
    const { toyBox, leads, as, post } = shared;
    const [rootTs, releasesTs, docsTs, bothTs] = timestamps(4);
    await post(said(ALICE, rootTs!, `<@${BOT}> <@${RELEASES_BOT}> is everything ready?`));
    await waitFor(() => expect(toyBox.runs).toHaveLength(2), 5_000);
    for (const lead of Object.values(leads)) await as(lead, "inbox");

    await post(
      said(ALICE, releasesTs!, `<@${RELEASES_BOT}> can you check the release?`, {
        thread_ts: rootTs,
      }),
    );
    await waitFor(() => expect(toyBox.runs).toHaveLength(3), 5_000);
    expect(toyBox.runs[2]?.channelId).toBe(leads.releases);
    expect((await as(leads.docs, "inbox")).json).toMatchObject({
      requests: [{ id: 1, attention: null }],
    });
    expect((await as(leads.releases, "inbox")).json).toMatchObject({
      requests: [{ id: 1, attention: "updated" }],
    });

    await post(said(ALICE, docsTs!, `<@${BOT}> can you check the docs?`, { thread_ts: rootTs }));
    await waitFor(() => expect(toyBox.runs).toHaveLength(4), 5_000);
    expect(toyBox.runs[3]?.channelId).toBe(leads.docs);
    expect((await as(leads.docs, "inbox")).json).toMatchObject({
      requests: [{ id: 1, attention: "updated" }],
    });
    expect((await as(leads.releases, "inbox")).json).toMatchObject({
      requests: [{ id: 1, attention: null }],
    });

    await post(said(ALICE, bothTs!, "And can you check production?", { thread_ts: rootTs }));
    await waitFor(() => expect(toyBox.runs).toHaveLength(6), 5_000);
    expect(
      toyBox.runs
        .slice(4)
        .map(({ channelId }) => channelId)
        .toSorted(),
    ).toEqual(Object.values(leads).toSorted());
    for (const lead of Object.values(leads))
      expect((await as(lead, "inbox")).json).toMatchObject({
        requests: [{ id: 1, attention: "updated" }],
      });
    await shared.stop();
  }, 15_000);

  test("editing a mention moves the request to the other lead, and deleting it ends that request", async () => {
    const shared = await startSharedChannel(async ({ home, releases, leads }) => {
      await linkLead(home, leads.docs);
      await linkLead(releases, leads.releases);
    });
    const { slack, toyBox, leads, as, post, deliver } = shared;
    const [askedTs, editedTs, deletedTs] = timestamps(3);
    const original = said(ALICE, askedTs!, `<@${BOT}> is everything ready?`);
    await post(original);
    await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
    await as(leads.docs, "inbox");
    const edited = {
      ...original,
      text: `<@${RELEASES_BOT}> is everything ready?`,
      edited: { user: ALICE, ts: editedTs },
    };
    slack.setMessage("C-link", edited);
    await deliver({
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: "C-link",
      message: edited,
      previous_message: original,
      ts: editedTs,
      event_ts: editedTs,
    });
    await waitFor(() => expect(toyBox.runs).toHaveLength(2), 5_000);
    expect(toyBox.runs.map(({ channelId }) => channelId)).toEqual([leads.docs, leads.releases]);
    expect((await as(leads.docs, "inbox")).json).toMatchObject({ requests: [] });
    expect((await as(leads.releases, "inbox")).json).toMatchObject({
      requests: [{ id: 1, messages: [{ ts: askedTs, edited: true }] }],
    });
    slack.deleteMessage("C-link", askedTs!);
    await deliver({
      type: "message",
      subtype: "message_deleted",
      hidden: true,
      channel: "C-link",
      deleted_ts: askedTs,
      previous_message: edited,
      ts: deletedTs,
      event_ts: deletedTs,
    });
    for (const lead of Object.values(leads))
      expect((await as(lead, "inbox")).json).toMatchObject({ requests: [] });
    await shared.stop();
    for (const folder of [shared.dataFolder, shared.releasesFolder])
      expect(
        await withDatabase(folder, (database) =>
          database.read(
            (sql) => sql`
              SELECT deleted, text, user_id FROM messages WHERE ts = ${askedTs}
            `,
          ),
        ),
      ).toEqual([{ deleted: 1, text: null, user_id: null }]);
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

  test("each lead's commands run in its own app, so its answer goes out as that app's bot", async () => {
    const shared = await startSharedChannel(async ({ home, releases, leads }) => {
      await linkLead(home, leads.docs);
      await linkLead(releases, leads.releases);
    });
    const { slack, releasesSlack, toyBox, leads, as, post } = shared;
    const [askedTs] = timestamps(1);

    await post(said(ALICE, askedTs!, `<@${RELEASES_BOT}> is the release out?`));
    await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
    const inbox = (lead: string) => as(lead, "inbox");
    expect((await inbox(leads.docs)).json).toMatchObject({ requests: [] });
    expect((await inbox(leads.releases)).json).toMatchObject({
      requests: [{ id: 1, requester: { userId: ALICE }, messages: [{ ts: askedTs }] }],
    });
    const answered = await as(leads.releases, "reply", { request: "r1", text: "It shipped." });
    expect(answered).toMatchObject({ exitCode: 0 });
    await waitFor(() => expect(postsBy(releasesSlack)).toHaveLength(1), 5_000);

    expect(toyBox.runs.map(({ channelId }) => channelId)).toEqual([leads.releases]);
    expect(postsBy(releasesSlack)[0]).toMatchObject({
      token: releasesSlack.botToken,
      args: { channel: "C-link", thread_ts: askedTs },
    });
    expect(postsBy(slack)).toEqual([]);
    await shared.stop();
  }, 15_000);

  test("status shows a terminal each app's connection and links under its name, and a lead its own", async () => {
    const shared = await startSharedChannel(async ({ home, releases, leads }) => {
      await linkLead(home, leads.docs);
      await linkLead(releases, leads.releases);
    });
    const { leads, as } = shared;
    const connected = { connection: "connected", problem: null };
    const linking = (lead: string) => [expect.objectContaining({ toyBoxChannelId: lead })];

    const every = await as(null, "status");
    const own = await as(leads.releases, "status");

    expect(every).toMatchObject({
      exitCode: 0,
      json: {
        apps: [
          { app: "default", slack: connected, links: linking(leads.docs) },
          { app: "releases", slack: connected, links: linking(leads.releases) },
        ],
      },
    });
    expect(every.text).toStartWith("# The default app\n\n## Slack\nConnected.\n\n## ");
    expect(every.text).toContain("\n\n# The releases app\n\n## Slack\nConnected.\n\n## ");
    expect(own).toMatchObject({
      exitCode: 0,
      json: { apps: [{ app: "releases", slack: connected, links: linking(leads.releases) }] },
    });
    await shared.stop();
  }, 15_000);

  test("two links racing to link one Toy Box channel through two apps leave it linked through one", async () => {
    const shared = await startSharedChannel();
    const { leads, as } = shared;
    shared.share({ id: "C0RELEASES", name: "releases" });
    const link = (app: string) =>
      as(null, "link", { slackChannel: "C0RELEASES", app }, { channelId: leads.docs });

    const [home, releases] = await Promise.all([link("default"), link("releases")]);

    const [linked, refused] = home.exitCode === 0 ? [home, releases] : [releases, home];
    const [winner, loser] = home.exitCode === 0 ? ["default", "releases"] : ["releases", "default"];
    expect(linked).toMatchObject({
      exitCode: 0,
      text: expect.stringContaining(`answers in #releases now as the ${winner} app's bot,`),
    });
    expect(refused).toMatchObject({
      exitCode: 1,
      text: `This Toy Box channel links through the ${winner} app. Run \`toy-box-slack unlink\` before you link it through the ${loser} app.`,
    });
    const status = (await as(null, "status")).json as { apps: { app: string; links: object[] }[] };
    expect(status.apps.map(({ app, links }) => [app, links.length])).toEqual([
      ["default", winner === "default" ? 1 : 0],
      ["releases", winner === "releases" ? 1 : 0],
    ]);
    await shared.stop();
  }, 15_000);
});

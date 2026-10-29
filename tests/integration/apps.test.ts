// One bridge hosting several apps, each answering through a Slack app of its own.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { createAddedApp, createTestFolder } from "@bridge/server/testFixtures";
import { refusalProblem, rejectedTokensProblem } from "@slackapi/model/identity";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import type { FakeSlackApp } from "../fakes/slack";
import { spawnBridge, started, startSlackForBridge, withDatabase } from "./bridgeProcess";
import { ALICE, posted, said, timestamps } from "./connectedBridge";

/** The Slack app the installation fixture records. */
const RECORDED = { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" };

const STOPPING = "toy-box-slack is stopping after SIGTERM\n";

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

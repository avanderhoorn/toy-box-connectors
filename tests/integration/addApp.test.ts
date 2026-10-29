// `toy-box-slack add-app` at the owner's terminal, the only place it adds an app.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { locateApp } from "@bridge/server/apps";
import { readAppCredentialsFile } from "@bridge/server/environment";
import { createTestFolder } from "@bridge/server/testFixtures";
import { runAtTerminal } from "./bridgeProcess";

const ASKS_BOT_TOKEN = "Paste the releases app's Slack bot token (xoxb-...): \n";
const ASKS_APP_TOKEN = "Paste the releases app's Slack app-level token (xapp-...): \n";

test("asks the owner at a terminal for the app's tokens, saves them in its folder, and says how to start it", async () => {
  const home = createTestFolder();
  const terminal = runAtTerminal(home, ["add-app", "releases"]);
  await terminal.shows("(xoxb-...): ");
  await terminal.type("xoxb-releases");
  await terminal.shows("(xapp-...): ");
  await terminal.type("xapp-releases");

  const app = locateApp(join(home, ".toy-box-slack"), "releases");
  expect(await terminal.exit()).toEqual({
    code: 0,
    transcript: [
      `${ASKS_BOT_TOKEN}${ASKS_APP_TOKEN}Added the releases app in ${app.folder}.`,
      'The bridge starts it when the bridge next starts. If the bridge is running, restart it: press Ctrl-C where `toy-box-slack serve` runs and run that again, or if it starts at login, run `launchctl kickstart -k "gui/$(id -u)/local.toy-box-slack"`.',
      "Then link a Toy Box channel through it with `toy-box-slack link --channel TOYBOX_ID --slack-channel SLACK_ID --app releases`.",
      "",
    ].join("\n"),
  });
  expect(readAppCredentialsFile(app.folder)).toEqual({
    SLACK_BOT_TOKEN: "xoxb-releases",
    SLACK_APP_TOKEN: "xapp-releases",
  });
}, 15_000);

test("adds nothing when the owner presses Ctrl-C at a prompt", async () => {
  const home = createTestFolder();
  const terminal = runAtTerminal(home, ["add-app", "releases"]);
  await terminal.shows("(xoxb-...): ");
  await terminal.type("xoxb-releases");
  await terminal.shows("(xapp-...): ");
  await terminal.interrupt();

  expect(await terminal.exit()).toEqual({
    code: 1,
    transcript: `${ASKS_BOT_TOKEN}${ASKS_APP_TOKEN}No Slack app-level token was given, so add-app didn't add the releases app.\n`,
  });
  expect(existsSync(join(home, ".toy-box-slack", "apps"))).toBe(false);
}, 15_000);

test("refuses in a lead's shell, which can be a terminal too, before asking anything", async () => {
  const home = createTestFolder();
  const lead = { COPILOT_AGENT_SESSION_ID: "a-lead-session" };
  const terminal = runAtTerminal(home, ["add-app", "releases"], lead);

  expect(await terminal.exit()).toEqual({
    code: 1,
    transcript: "Only the owner at a terminal runs `add-app`.\n",
  });
  expect(existsSync(join(home, ".toy-box-slack"))).toBe(false);
}, 15_000);

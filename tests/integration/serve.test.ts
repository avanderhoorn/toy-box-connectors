// What `toy-box-slack serve` sets up as it starts, before it says it's running: what it asks the
// owner for at a terminal, and the skill.

import { expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCredentialsFile } from "@bridge/server/environment";
import { createTestFolder } from "@bridge/server/testFixtures";
import { runAtTerminal, spawnBridge, startSlackForBridge, started } from "./bridgeProcess";

/** What the terminal shows as the owner presses Ctrl-C while the bridge runs. */
const STOPPED_AT_TERMINAL = "^Ctoy-box-slack is stopping after SIGINT\n";

test("asks the owner at a terminal for both tokens the first time, then starts", async () => {
  const home = createTestFolder();
  const { slack } = startSlackForBridge();
  const terminal = runAtTerminal(home, ["serve"], { SLACK_API_URL: slack.url });

  for (const [prompt, answer] of [
    ["(xoxb-...): ", slack.botToken],
    ["(xapp-...): ", slack.appToken],
  ]) {
    await terminal.shows(prompt);
    await terminal.type(answer);
  }
  await terminal.shows("Connected to Slack.");
  await terminal.interrupt();

  const dataFolder = join(home, ".toy-box-slack");
  const credentials = join(dataFolder, "credentials.env");
  expect(await terminal.exit()).toEqual({
    code: 0,
    transcript: [
      "Paste the Slack bot token (xoxb-...): ",
      "Paste the Slack app-level token (xapp-...): ",
      `Saved SLACK_BOT_TOKEN and SLACK_APP_TOKEN in ${credentials}.`,
      `${started(home)}Connected to Slack.`,
      STOPPED_AT_TERMINAL,
    ].join("\n"),
  });
  expect(statSync(credentials).mode & 0o777).toBe(0o600);
  expect(readCredentialsFile(dataFolder)).toEqual({
    SLACK_BOT_TOKEN: slack.botToken,
    SLACK_APP_TOKEN: slack.appToken,
  });
}, 15_000);

test("never asks in a lead's shell, which can be a terminal too", async () => {
  const home = createTestFolder();
  const terminal = runAtTerminal(home, ["serve"], { COPILOT_AGENT_SESSION_ID: "a-lead-session" });
  await terminal.shows("toy-box-slack is running");
  await terminal.interrupt();

  expect(await terminal.exit()).toEqual({
    code: 0,
    transcript: `${started(home)}${STOPPED_AT_TERMINAL}`,
  });
  expect(existsSync(join(home, ".toy-box-slack", "credentials.env"))).toBe(false);
}, 15_000);

test("says why it couldn't install the skill, and runs anyway", async () => {
  const home = createTestFolder();
  writeFileSync(join(home, ".copilot"), "Not a folder");

  const bridge = spawnBridge(home);
  await bridge.running();
  bridge.child.kill("SIGTERM");

  const { code, stderr } = await bridge.exit();
  const [said, ...rest] = stderr.split("\n");
  expect(code).toBe(0);
  expect(said).toStartWith("Couldn't install the toy-box-slack skill: ENOTDIR: not a directory");
  expect(rest.join("\n")).toBe(
    `toy-box-slack is running for ${join(home, ".toy-box-slack")}\ntoy-box-slack is stopping after SIGTERM\n`,
  );
}, 15_000);

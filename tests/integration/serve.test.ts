// What `toy-box-slack serve` sets up as it starts, before it says it's running: what it asks the
// owner for at a terminal, and the skill.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCredentialsFile } from "@bridge/server/environment";
import { createTestFolder } from "@bridge/server/testFixtures";
import { BUNDLED_SKILL } from "@commands/client/skill";
import {
  installedSkill,
  serveAtTerminal,
  spawnBridge,
  startSlackForBridge,
  started,
} from "./bridgeProcess";

const PASSPHRASE = "correct horse battery staple";
/** What the terminal shows as the owner presses Ctrl-C while the bridge runs. */
const STOPPED_AT_TERMINAL = "^Ctoy-box-slack is stopping after SIGINT\n";

test("asks the owner at a terminal for both tokens and a passphrase the first time, then starts", async () => {
  const home = createTestFolder();
  const { slack } = startSlackForBridge();
  const terminal = serveAtTerminal(home, { SLACK_API_URL: slack.url });

  for (const [prompt, answer] of [
    ["(xoxb-...): ", slack.botToken],
    ["(xapp-...): ", slack.appToken],
    ["ask for: ", PASSPHRASE],
    ["again: ", PASSPHRASE],
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
      "Choose the owner's passphrase, which link, allow and resume ask for: ",
      "The new passphrase again: ",
      `Saved SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and OWNER_PASSPHRASE_HASH in ${credentials}.`,
      `${started(home)}Connected to Slack.`,
      STOPPED_AT_TERMINAL,
    ].join("\n"),
  });
  expect(statSync(credentials).mode & 0o777).toBe(0o600);
  const { OWNER_PASSPHRASE_HASH, ...tokens } = readCredentialsFile(dataFolder);
  expect(tokens).toEqual({ SLACK_BOT_TOKEN: slack.botToken, SLACK_APP_TOKEN: slack.appToken });
  expect(await Bun.password.verify(PASSPHRASE, OWNER_PASSPHRASE_HASH ?? "")).toBe(true);
}, 15_000);

test("stops without saving or starting when the owner presses Ctrl-C at a prompt", async () => {
  const home = createTestFolder();
  const terminal = serveAtTerminal(home);
  await terminal.shows("(xoxb-...): ");
  await terminal.interrupt();

  expect(await terminal.exit()).toEqual({
    code: 1,
    transcript:
      "Paste the Slack bot token (xoxb-...): \nNo Slack bot token was given, so toy-box-slack didn't start.\n",
  });
  expect(existsSync(join(home, ".toy-box-slack", "credentials.env"))).toBe(false);
}, 15_000);

test("never asks in a lead's shell, which can be a terminal too", async () => {
  const home = createTestFolder();
  const terminal = serveAtTerminal(home, { COPILOT_AGENT_SESSION_ID: "a-lead-session" });
  await terminal.shows("toy-box-slack is running");
  await terminal.interrupt();

  expect(await terminal.exit()).toEqual({
    code: 0,
    transcript: `${started(home)}${STOPPED_AT_TERMINAL}`,
  });
  expect(existsSync(join(home, ".toy-box-slack", "credentials.env"))).toBe(false);
}, 15_000);

test("never asks without a terminal, even when stdin holds the answers", async () => {
  const home = createTestFolder();
  const { slack } = startSlackForBridge();
  const answers = [slack.botToken, slack.appToken, PASSPHRASE, PASSPHRASE, ""].join("\n");

  const bridge = spawnBridge(home, { SLACK_API_URL: slack.url }, new Blob([answers]));
  await bridge.running();
  bridge.child.kill("SIGTERM");

  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `${started(home)}toy-box-slack is stopping after SIGTERM\n`,
  });
  expect(existsSync(join(home, ".toy-box-slack", "credentials.env"))).toBe(false);
}, 15_000);

test("installs the skill it ships each time it starts, in place of the one before", async () => {
  const home = createTestFolder();
  const skill = installedSkill(home);
  mkdirSync(join(dirname(skill), "references"), { recursive: true });
  writeFileSync(skill, "An older release's skill");
  writeFileSync(join(dirname(skill), "references", "stale.md"), "Stale");

  const bridge = spawnBridge(home);
  await bridge.running();

  expect(await Bun.file(skill).text()).toBe(await Bun.file(BUNDLED_SKILL).text());
  expect(readdirSync(dirname(skill))).toEqual(["SKILL.md"]);
  bridge.child.kill("SIGTERM");
  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `${started(home)}toy-box-slack is stopping after SIGTERM\n`,
  });
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

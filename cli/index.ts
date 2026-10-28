#!/usr/bin/env -S bun --no-env-file

// Bun would otherwise load a .env file from whatever folder the CLI runs in, where a project's
// COPILOT_AGENT_SESSION_ID or TOY_BOX_SLACK_HOME would change who the caller seems to be or which
// bridge it reaches.

import { defineCommand, runMain } from "citty";
import { socketCommands } from "@commands/client/cli";
import { installSkill } from "@commands/client/skill";

import { version } from "../package.json";

const serve = defineCommand({
  meta: { name: "serve", description: "Run the bridge in the foreground until SIGTERM or SIGINT" },
  async run() {
    // Loaded on demand so the commands the lead runs don't load the bridge.
    const { serveBridge } = await import("@bridge/server/bridge");
    process.exitCode = await serveBridge();
  },
});

const install = defineCommand({
  meta: {
    name: "install-skill",
    description: "Install the toy-box-slack skill where Copilot leads find it",
  },
  async run() {
    console.log(await installSkill());
  },
});

const main = defineCommand({
  meta: {
    name: "toy-box-slack",
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
  },
  subCommands: { ...socketCommands(), serve, "install-skill": install },
});

await runMain(main);

#!/usr/bin/env -S bun --no-env-file

// Bun would otherwise load a .env file from whatever folder the CLI runs in, where a project's
// COPILOT_AGENT_SESSION_ID or TOY_BOX_SLACK_HOME would change who the caller seems to be or which
// bridge it reaches.

import { defineCommand, runMain } from "citty";
import { resolveDataFolder } from "@bridge/server/dataFolder";
import { addApp } from "@commands/client/addApp";
import { socketCommands } from "@commands/client/cli";

import { version } from "../package.json";

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "Run the bridge, asking at a terminal for what's missing, and install its skill",
  },
  async run() {
    // Loaded on demand so the commands the lead runs don't load the bridge.
    const { serveBridge } = await import("@bridge/server/bridge");
    process.exitCode = await serveBridge();
  },
});

const addAppCommand = defineCommand({
  meta: {
    name: "add-app",
    description:
      "Add another Slack app for the bridge to host, asking at a terminal for its tokens",
  },
  args: {
    name: { type: "positional", description: "The app's name, such as releases", required: true },
  },
  async run({ args }) {
    process.exitCode = await addApp(resolveDataFolder(), args.name);
  },
});

const main = defineCommand({
  meta: {
    name: "toy-box-slack",
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
  },
  subCommands: { ...socketCommands(), serve, "add-app": addAppCommand },
});

await runMain(main);

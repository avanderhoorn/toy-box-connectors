#!/usr/bin/env -S bun --no-env-file

// Bun would otherwise load a .env file from whatever folder the CLI runs in, where a project's
// COPILOT_AGENT_SESSION_ID or TOY_BOX_SLACK_HOME would change who the caller seems to be or which
// bridge it reaches.

import { defineCommand, runMain } from "citty";
import { resolveDataFolder } from "@bridge/server/dataFolder";
import { socketCommands } from "@commands/client/cli";
import { setPassphrase } from "@commands/client/passphrase";

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

const passphrase = defineCommand({
  meta: {
    name: "passphrase",
    description: "Set the owner's passphrase, or change it given the old one",
  },
  async run() {
    process.exitCode = await setPassphrase(resolveDataFolder());
  },
});

const main = defineCommand({
  meta: {
    name: "toy-box-slack",
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
  },
  subCommands: { ...socketCommands(), serve, passphrase },
});

await runMain(main);

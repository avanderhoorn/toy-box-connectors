#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";

import { version } from "../package.json";

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "Run the bridge in the foreground until SIGTERM or SIGINT",
  },
  async run() {
    // Loaded on demand so the commands the lead runs don't load the bridge.
    const { serveBridge } = await import("@bridge/server/bridge");
    process.exitCode = await serveBridge();
  },
});

const main = defineCommand({
  meta: {
    name: "toy-box-slack",
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
  },
  subCommands: { serve },
});

await runMain(main);

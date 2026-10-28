#!/usr/bin/env -S bun --no-env-file

// Bun would otherwise load a .env file from whatever folder the CLI runs in, where a project's
// NITRO_PORT or TOY_BOX_SLACK_HOME would change who the caller seems to be or which bridge it
// reaches.

import { defineCommand } from "citty";
import { runCli, socketCommands } from "@commands/client/cli";

import { version } from "../package.json";

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "Run the bridge in the foreground until SIGTERM or SIGINT",
  },
  async run({ rawArgs }) {
    if (rawArgs.length > 0) {
      process.stderr.write(
        "`serve` takes no arguments. It runs the bridge for TOY_BOX_SLACK_HOME, or ~/.toy-box-slack when that's unset.\n",
      );
      process.exitCode = 1;
      return;
    }
    // Loaded on demand so the commands the lead runs don't load the bridge.
    const { serveBridge } = await import("@bridge/server/bridge");
    process.exitCode = await serveBridge();
  },
});

await runCli(
  {
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
    commands: { ...socketCommands(), serve },
  },
  process.argv.slice(2),
);

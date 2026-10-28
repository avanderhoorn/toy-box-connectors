#!/usr/bin/env -S bun --no-env-file

// Bun would otherwise load a .env file from whatever folder the CLI runs in, where a project's
// NITRO_PORT or TOY_BOX_SLACK_HOME would change who the caller seems to be or which bridge it
// reaches.

import { z } from "zod";
import { localCommand, runCli, socketCommands } from "@commands/client/cli";
import { installBundledSkill } from "@commands/client/skill";

import { version } from "../package.json";

const serve = localCommand({
  description: "Run the bridge in the foreground until SIGTERM or SIGINT",
  input: z.object({}).strict(),
  async run() {
    // Loaded on demand so the commands the lead runs don't load the bridge.
    const { serveBridge } = await import("@bridge/server/bridge");
    return await serveBridge();
  },
});

const installSkill = localCommand({
  description: "Install the toy-box-slack skill where Copilot leads find it",
  input: z.object({}).strict(),
  run: () => installBundledSkill(),
});

await runCli(
  {
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
    commands: { ...socketCommands(), serve, "install-skill": installSkill },
  },
  process.argv.slice(2),
);

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { version } from "../../package.json";
import { readCommandLog } from "./commandLog";
import { installCommands, isolatedEnvironment } from "./isolatedToyBox";

describe("isolatedEnvironment", () => {
  test("drops what points at the owner and runs Toy Box under its own home", () => {
    const parent = {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/Users/owner",
      BUN_BE_BUN: "1",
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: "3100",
      COPILOT_AGENT_SESSION_ID: "owner-session",
      COPILOT_GITHUB_TOKEN: "owner-token",
      GH_TOKEN: "owner-token",
      GITHUB_TOKEN: "owner-token",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      SLACK_BOT_TOKEN: "xoxb-owner",
      TOY_BOX_SLACK_HOME: "/Users/owner/.toy-box-slack",
      XDG_CONFIG_HOME: "/Users/owner/.config",
      UNSET: undefined,
    };

    const environment = isolatedEnvironment(parent, {
      home: "/tmp/run/home",
      bin: "/tmp/run/bin",
      token: "test-token",
    });

    expect(environment).toEqual({
      PATH: "/tmp/run/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/tmp/run/home",
      COPILOT_GITHUB_TOKEN: "test-token",
    });
  });
});

describe("installCommands", () => {
  test("puts the CLI under test on PATH and logs each run without the token", () => {
    const folder = createTestFolder();
    const [bin, home] = [join(folder, "bin"), join(folder, "home")];
    for (const path of [bin, home]) mkdirSync(path);
    const log = join(folder, "commands.jsonl");
    installCommands(bin, log);
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      NITRO_PORT: "3199",
      COPILOT_AGENT_SESSION_ID: "channel-1",
      COPILOT_GITHUB_TOKEN: "test-token",
    };
    const run = (...args: string[]) =>
      Bun.spawnSync([join(bin, "toy-box-slack"), ...args], { cwd: home, env });

    const versioned = run("--version");
    // No bridge runs for the temp HOME.
    const unserved = run("status", "--channel", "it's two words");

    expect(versioned.stdout.toString().trim()).toBe(version);
    expect([versioned.exitCode, unserved.exitCode]).toEqual([0, 2]);
    const where = { HOME: home, NITRO_PORT: "3199", COPILOT_AGENT_SESSION_ID: "channel-1" };
    expect(readCommandLog(log)).toEqual([
      { command: "toy-box-slack", args: ["--version"], status: 0, env: where },
      {
        command: "toy-box-slack",
        args: ["status", "--channel", "it's two words"],
        status: 2,
        env: where,
      },
    ]);
    expect(readFileSync(log, "utf8")).not.toContain("test-token");
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { version } from "../../package.json";
import { installCli, isolatedEnvironment } from "./isolatedToyBox";

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

describe("installCli", () => {
  test("puts the CLI under test on PATH", () => {
    const bin = createTestFolder();
    installCli(bin);

    const versioned = Bun.spawnSync([join(bin, "toy-box-slack"), "--version"], {
      env: { PATH: "/usr/bin:/bin" },
    });

    expect(versioned.exitCode).toBe(0);
    expect(versioned.stdout.toString().trim()).toBe(version);
  });
});

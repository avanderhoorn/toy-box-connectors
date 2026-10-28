import { expect, test } from "bun:test";
import { isolatedEnvironment } from "./isolatedToyBox";

test("Toy Box runs without what points at the owner, under its own home", () => {
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

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { fetchToyBoxCatalog } from "@toybox/server/api";
import { version } from "../../package.json";
import { readCommandLog } from "./commandLog";
import { installCommands, isolatedEnvironment, waitUntil } from "./isolatedToyBox";
import { describeEndToEnd } from "./suite";
import { CREATE_CHANNEL_TIMEOUT, createTestChannel, type TestChannel } from "./testChannel";

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
    installCommands(bin, log, { "tbs-e2e-probe": [], "tbs-e2e-false": ["false"] });
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      NITRO_PORT: "3199",
      COPILOT_AGENT_SESSION_ID: "channel-1",
      COPILOT_GITHUB_TOKEN: "test-token",
    };
    const run = (...command: string[]) => Bun.spawnSync(command, { cwd: home, env });

    const cli = run(join(bin, "toy-box-slack"), "--version");
    const probe = run(join(bin, "tbs-e2e-probe"), "it's", "two words");
    const failing = run(join(bin, "tbs-e2e-false"));

    expect(cli.stdout.toString().trim()).toBe(version);
    expect([cli.exitCode, probe.exitCode, failing.exitCode]).toEqual([0, 0, 1]);
    const where = { HOME: home, NITRO_PORT: "3199", COPILOT_AGENT_SESSION_ID: "channel-1" };
    expect(readCommandLog(log)).toEqual([
      { command: "toy-box-slack", args: ["--version"], status: 0, env: where },
      { command: "tbs-e2e-probe", args: ["it's", "two words"], status: 0, env: where },
      { command: "tbs-e2e-false", args: [], status: 1, env: where },
    ]);
    expect(readFileSync(log, "utf8")).not.toContain("test-token");
  });
});

// Each run's skill asks for its own argument, so a run can't pass on another run's command.
const nonce = crypto.randomUUID().slice(0, 8);

describeEndToEnd(
  "an isolated Toy Box",
  { skills: { "tbs-e2e-probe": probeSkill(nonce) }, commands: { "tbs-e2e-probe": [] } },
  (suite) => {
    let channel: TestChannel;
    beforeAll(async () => {
      channel = await createTestChannel(suite.toyBox, {
        name: "Test channel",
        purpose: "Follow the owner's and routines' instructions exactly.",
      });
    }, CREATE_CHANNEL_TIMEOUT);

    // Whether the lead waits for the owner after its kickoff is its call, but a wake it schedules
    // could start a turn in the middle of a scenario.
    suite.scenario(
      "a test channel's lead kicks off alone, with no wake scheduled",
      async () => {
        const catalog = await fetchToyBoxCatalog(suite.toyBox.origin);

        expect(catalog.members).toEqual([]);
        expect(channel.presence()).not.toHaveProperty("wakeAt");
      },
      { turns: 0 },
    );

    suite.scenario(
      "a routine run wakes the lead, which runs a skill's command on the harness's PATH",
      async () => {
        if (!channel.routine("E2E probe")) {
          await channel.turn(() =>
            channel.post(
              'Add a routine titled "E2E probe" with the schedule "0 4 1 1 *" and exactly this prompt: "Use the tbs-e2e-probe skill." Don\'t use the skill now.',
            ),
          );
        }
        const routine = await waitUntil(
          "Toy Box to report the routine",
          () => channel.routine("E2E probe"),
          10_000,
        );
        const before = suite.toyBox.commandRuns().length;

        const turn = await channel.turn(() => channel.runRoutine(routine.id));

        expect(turn.at(-1)).toEqual({ state: "idle" });
        expect(suite.toyBox.commandRuns().slice(before)).toEqual([
          {
            command: "tbs-e2e-probe",
            args: [nonce],
            status: 0,
            env: {
              HOME: suite.toyBox.home,
              NITRO_PORT: "3199",
              COPILOT_AGENT_SESSION_ID: channel.id,
            },
          },
        ]);
      },
      { turns: 2 },
    );

    suite.scenario(
      "a lead that finishes waiting shows when it will check back",
      async () => {
        const turn = await channel.turn(() =>
          channel.post(
            'Finish this turn waiting for "the nightly build", and check back in 30 minutes.',
          ),
        );

        const settled = turn.at(-1);
        expect(settled?.state).toBe("waiting");
        const wakeAt = settled?.state === "waiting" ? Date.parse(settled.wakeAt ?? "") : NaN;
        expect(wakeAt - Date.now()).toBeGreaterThan(25 * 60_000);
        expect(wakeAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
      },
      { turns: 1 },
    );

    suite.scenario(
      "the run leaves the owner's Toy Box and Copilot untouched",
      async () => {
        const catalog = await fetchToyBoxCatalog(suite.toyBox.origin);
        const { home } = suite.toyBox;

        expect(catalog.channels.map(({ id }) => id)).toEqual([channel.id]);
        expect(existsSync(join(home, ".copilot", "session-state", channel.id))).toBe(true);
        expect(existsSync(join(home, ".toy-box", "sessions", channel.id))).toBe(true);
        for (const path of [
          join(".copilot", "session-state", channel.id),
          join(".toy-box", "sessions", channel.id),
          join(".copilot", "skills", "tbs-e2e-probe"),
        ]) {
          expect(existsSync(join(homedir(), path))).toBe(false);
        }
      },
      { turns: 0 },
    );
  },
);

function probeSkill(argument: string): string {
  return `---
name: tbs-e2e-probe
description: Runs the tbs-e2e-probe command. Use it only when a message or routine names this skill.
---

Run \`tbs-e2e-probe ${argument}\` in a shell. Then post nothing, and end your turn with finish_agent_turn without waitingFor.
`;
}

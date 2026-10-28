// The CLI in its own process, the way a lead runs it, with only the environment each test gives it.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { commandRefusalSchema, commandResultSchema } from "@commands/model/protocol";
import { statusResultSchema } from "@commands/model/status";
import { version } from "../../package.json";
import { startLinkedBridge } from "./linkedBridge";
import { waitFor } from "./waitFor";

const CLI = join(import.meta.dir, "..", "..", "cli", "index.ts");

/**
 * Runs `toy-box-slack <args>` with `env` and `PATH` as its whole environment, and a home folder
 * of its own unless `env` names one. Resolves once it exits, with what it printed.
 */
async function runToyBoxSlack(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: createTestFolder(), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(() => child.kill("SIGKILL"));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** The environment Toy Box gives the lead of `channelId`, for a bridge whose home is `home`. */
function leadEnvironment(home: string, channelId: string, port: number) {
  return { HOME: home, COPILOT_AGENT_SESSION_ID: channelId, NITRO_PORT: String(port) };
}

test("ignores a .env file in the folder it runs from", async () => {
  const home = createTestFolder();
  const project = createTestFolder();
  writeFileSync(join(project, ".env"), "TOY_BOX_URL=http://toy-box.example.com:3000\n");

  // Run through the file's own shebang, the way a shell or launchd runs the installed CLI, with
  // the Bun running these tests first on PATH.
  const bin = createTestFolder();
  symlinkSync(process.execPath, join(bin, "bun"));
  const child = Bun.spawn([CLI, "serve"], {
    cwd: project,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  onTestFinished(() => child.kill("SIGKILL"));

  const decoder = new TextDecoder();
  let stderr = "";
  for await (const chunk of child.stderr) {
    stderr += decoder.decode(chunk, { stream: true });
    if (stderr.includes("toy-box-slack is running")) break;
  }
  child.kill("SIGTERM");

  expect(stderr).toBe(`toy-box-slack is running for ${join(home, ".toy-box-slack")}\n`);
  expect(await child.exited).toBe(0);
}, 15_000);

test("prints the lead's status on stdout and exits 0", async () => {
  const { channelId, home, port } = await startLinkedBridge();
  const lead = leadEnvironment(home, channelId, port);

  // Once the bridge follows the channel and has decided about waking its lead, status holds still.
  let answer;
  await waitFor(async () => {
    const run = await runToyBoxSlack(["status", "--json"], lead);
    expect(run).toMatchObject({ exitCode: 0, stderr: "" });
    answer = commandResultSchema(statusResultSchema).parse(JSON.parse(run.stdout));
    expect(answer.result).toMatchObject({
      channelId,
      links: [{ following: true, wake: { kind: "idle" } }],
    });
  }, 10_000);
  const [link] = answer!.result.links;

  expect(await runToyBoxSlack(["status"], lead)).toEqual({
    exitCode: 0,
    stdout: `> Slack: not set up · coverage complete, see \`toy-box-slack status\`

## Slack
Not set up. SLACK_BOT_TOKEN and SLACK_APP_TOKEN aren't set. Add them to credentials.env in the bridge's data folder, then restart the bridge.

Toy Box: ${answer!.result.toyBox}

## Toy Box channel ${channelId} and Slack channel ${link!.slackChannelId}
- Link: active.
- Coverage: complete.
- Toy Box: following the channel
- Wakes: nothing is waiting for the lead.
- Requests routine: ${link!.routines[0]!.routineId}.
`,
    stderr: "",
  });
}, 20_000);

test("refuses a session that isn't in the bridge's Toy Box, on stderr with exit 1", async () => {
  const { toyBox, home, port } = await startLinkedBridge();
  const stranger = leadEnvironment(home, "session-elsewhere", port);
  const message = `Session session-elsewhere isn't the lead or a member of a channel in the Toy Box at ${toyBox.url}, so the bridge won't act for it.`;

  expect(await runToyBoxSlack(["status"], stranger)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${message}\n`,
  });
  const json = await runToyBoxSlack(["status", "--json"], stranger);
  expect(json).toMatchObject({ exitCode: 1, stderr: "" });
  expect(commandRefusalSchema.parse(JSON.parse(json.stdout)).refused).toEqual({
    rule: "unknown_session",
    message,
  });
}, 20_000);

test("exits 2 when no bridge is running for its data folder", async () => {
  const home = createTestFolder();
  const message = `No bridge is running for ${join(home, ".toy-box-slack")}, so \`status\` didn't run. Whoever runs the bridge can start it with \`toy-box-slack serve\`.`;

  expect(await runToyBoxSlack(["status"], { HOME: home })).toEqual({
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n`,
  });
  expect(await runToyBoxSlack(["status", "--json"], { HOME: home })).toEqual({
    exitCode: 2,
    stdout: `${JSON.stringify({ error: message }, null, 2)}\n`,
    stderr: "",
  });
});

test("exits 2 when the bridge was killed and left its socket behind", async () => {
  const { bridge, channelId, home, port, dataFolder, socket } = await startLinkedBridge();
  bridge.child.kill("SIGKILL");
  await bridge.child.exited;
  expect(existsSync(socket)).toBe(true);

  expect(await runToyBoxSlack(["status"], leadEnvironment(home, channelId, port))).toEqual({
    exitCode: 2,
    stdout: "",
    stderr: `The bridge for ${dataFolder} has stopped, so \`status\` didn't run. Whoever runs the bridge can start it with \`toy-box-slack serve\`.\n`,
  });
}, 20_000);

test.each([
  [
    [],
    "Name a command, as in `toy-box-slack status`. Run `toy-box-slack --help` to see the commands.",
  ],
  [
    ["bogus"],
    "toy-box-slack has no command `bogus`. Run `toy-box-slack --help` to see the commands.",
  ],
  [
    ["toString"],
    "toy-box-slack has no command `toString`. Run `toy-box-slack --help` to see the commands.",
  ],
  [
    ["--channel", "c1", "status"],
    "Name the command before its options, as in `toy-box-slack status --channel c1`. Run `toy-box-slack --help` to see the commands.",
  ],
  [["status", "--bogus"], "`status` has no option --bogus. Run `toy-box-slack status --help`."],
  [
    ["serve", "--bogus"],
    "`serve` takes no arguments. It runs the bridge for TOY_BOX_SLACK_HOME, or ~/.toy-box-slack when that's unset.",
  ],
])(
  "refuses `toy-box-slack %j` on stderr with exit 1, before calling any bridge",
  async (args, message) => {
    expect(await runToyBoxSlack(args)).toEqual({ exitCode: 1, stdout: "", stderr: `${message}\n` });
  },
);

test("refuses a command line that asks for JSON with JSON on stdout", async () => {
  expect(await runToyBoxSlack(["--json", "status"])).toEqual({
    exitCode: 1,
    stdout: `${JSON.stringify({ error: "Name the command before its options, as in `toy-box-slack status --json`. Run `toy-box-slack --help` to see the commands." }, null, 2)}\n`,
    stderr: "",
  });
});

test.each([
  [
    ["--help"],
    `Let a Toy Box channel's lead watch and answer a Slack channel

Usage: toy-box-slack <command> [options]

Commands:
  status  Show Slack's connection and the health of each link
  serve   Run the bridge in the foreground until SIGTERM or SIGINT

Run \`toy-box-slack <command> --help\` to see a command's options.
`,
  ],
  [
    ["status", "--help"],
    `Show Slack's connection and the health of each link

Usage: toy-box-slack status [options]

Options:
  --channel <id>  The Toy Box channel to act for, from a terminal
  --json          Print the bridge's answer as JSON
`,
  ],
  [
    ["serve", "--help"],
    `Run the bridge in the foreground until SIGTERM or SIGINT

Usage: toy-box-slack serve
`,
  ],
  [["--version"], `${version}\n`],
])("answers `toy-box-slack %j` on stdout without a bridge", async (args, stdout) => {
  expect(await runToyBoxSlack(args)).toEqual({ exitCode: 0, stdout, stderr: "" });
});

// The CLI in its own process, the way a lead runs it, with only the environment each test gives it.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { commandRefusalSchema, commandResultSchema } from "@commands/model/protocol";
import { statusResultSchema } from "@commands/model/status";
import { routineTemplates } from "@toybox/model/routines";
import { version } from "../../package.json";
import { startLinkedBridge } from "./linkedBridge";
import { waitFor } from "./waitFor";

const CLI = join(import.meta.dir, "..", "..", "cli", "index.ts");
const SKILL = join(import.meta.dir, "..", "..", "skills", "toy-box-slack", "SKILL.md");

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

test("prints the link's requests routine, and how to replace it once it's deleted", async () => {
  const { toyBox, channelId, routine, home, port } = await startLinkedBridge();
  const lead = leadEnvironment(home, channelId, port);
  const { title, schedule, prompt } = routineTemplates.requests;
  const requests = (banner: string, step: string) => ({
    exitCode: 0,
    stdout: `${banner}

Register a routine with set_routine, using the title, schedule and prompt shown for it, and change a schedule only if the owner asks.

## ${title}

Every link needs it. The bridge runs it whenever requests need you, so its schedule is only a safety net.

Title \`${title}\`, schedule \`${schedule}\`, prompt:

\`\`\`
${prompt}
\`\`\`

${step}
`,
    stderr: "",
  });

  await waitFor(async () => {
    expect(await runToyBoxSlack(["routines", "--template", "requests"], lead)).toEqual(
      requests(
        "> Slack: not set up · coverage complete, see `toy-box-slack status`",
        `The link uses routine ${routine.id}. To update it in place, pass routineId ${routine.id} to set_routine with this prompt, keeping its title and schedule. To replace it, register this one, then run \`toy-box-slack routine --requests <routineId>\` with the routineId set_routine returned.`,
      ),
    );
  }, 10_000);
  toyBox.deleteRoutine(channelId, routine.id);

  await waitFor(async () => {
    expect(await runToyBoxSlack(["routines", "--template", "requests"], lead)).toEqual(
      requests(
        "> Slack: not set up · coverage complete · the requests routine is gone, register a new one from `toy-box-slack routines --template requests`, see `toy-box-slack status`",
        `The link's routine ${routine.id} was deleted, so register this one, then run \`toy-box-slack routine --requests <routineId>\` with the routineId set_routine returned.`,
      ),
    );
  }, 10_000);
}, 30_000);

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
  [["serve", "--bogus"], "`serve` has no option --bogus. Run `toy-box-slack serve --help`."],
  [["serve", "--json"], "`serve` has no option --json. Run `toy-box-slack serve --help`."],
  [
    ["serve", "extra"],
    "`serve` takes no arguments, but also got extra. Run `toy-box-slack serve --help`.",
  ],
  [
    ["install-skill", "--json"],
    "`install-skill` has no option --json. Run `toy-box-slack install-skill --help`.",
  ],
  [
    ["install-skill", "extra"],
    "`install-skill` takes no arguments, but also got extra. Run `toy-box-slack install-skill --help`.",
  ],
  [
    ["dismiss", "14", "--revision", "2", "--reason", " "],
    "<request>: Write it as inbox shows it, such as r14. --reason: Can't be blank. Run `toy-box-slack dismiss --help`.",
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
  status         Show Slack's connection and the health of each link
  inbox          Read new and changed Slack requests, and how the owner decided your proposals
  hold           Stop reminders about a request while you wait for the owner to decide
  dismiss        Close a request that needs no answer, without replying in Slack
  routines       Show the routines to register in Toy Box, with their prompts
  serve          Run the bridge in the foreground until SIGTERM or SIGINT
  install-skill  Install the toy-box-slack skill where Copilot leads find it

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
    ["inbox", "--help"],
    `Read new and changed Slack requests, and how the owner decided your proposals

Usage: toy-box-slack inbox [options]

Options:
  --limit <number>  The most requests to show in each list
  --channel <id>    The Toy Box channel to act for, from a terminal
  --json            Print the bridge's answer as JSON
`,
  ],
  [
    ["hold", "--help"],
    `Stop reminders about a request while you wait for the owner to decide

Usage: toy-box-slack hold <request> --reason <value> [options]

Arguments:
  <request>         The request, such as r14

Options:
  --reason <value>  What you're waiting for the owner to decide
  --channel <id>    The Toy Box channel to act for, from a terminal
  --json            Print the bridge's answer as JSON
`,
  ],
  [
    ["dismiss", "--help"],
    `Close a request that needs no answer, without replying in Slack

Usage: toy-box-slack dismiss <request> --revision <number> --reason <value> [options]

Arguments:
  <request>            The request, such as r14

Options:
  --revision <number>  The revision you read, which inbox and thread show
  --reason <value>     Why it needs no answer
  --channel <id>       The Toy Box channel to act for, from a terminal
  --json               Print the bridge's answer as JSON
`,
  ],
  [
    ["routines", "--help"],
    `Show the routines to register in Toy Box, with their prompts

Usage: toy-box-slack routines [options]

Options:
  --template <requests|digest|release-notes>  Show only this routine
  --channel <id>                              The Toy Box channel to act for, from a terminal
  --json                                      Print the bridge's answer as JSON
`,
  ],
  [
    ["serve", "--help"],
    `Run the bridge in the foreground until SIGTERM or SIGINT

Usage: toy-box-slack serve
`,
  ],
  [
    ["install-skill", "--help"],
    `Install the toy-box-slack skill where Copilot leads find it

Usage: toy-box-slack install-skill
`,
  ],
  [["--version"], `${version}\n`],
])("answers `toy-box-slack %j` on stdout without a bridge", async (args, stdout) => {
  expect(await runToyBoxSlack(args)).toEqual({ exitCode: 0, stdout, stderr: "" });
});

test("installs the skill it ships into ~/.copilot/skills, and says when leads see it", async () => {
  const home = createTestFolder();
  const path = join(home, ".copilot", "skills", "toy-box-slack", "SKILL.md");

  expect(await runToyBoxSlack(["install-skill"], { HOME: home })).toEqual({
    exitCode: 0,
    stdout: `Installed the toy-box-slack skill at ${path}.

Copilot reads skills when a lead's session starts or resumes, so a lead that's already running may not see it until later. Until then, its routines carry what each run needs.
`,
    stderr: "",
  });
  expect(await Bun.file(path).text()).toBe(await Bun.file(SKILL).text());
});

test("installs the skill into COPILOT_HOME when it's set, and says leads find it only there", async () => {
  const home = createTestFolder();
  const copilotHome = createTestFolder();
  const path = join(copilotHome, "skills", "toy-box-slack", "SKILL.md");

  expect(
    await runToyBoxSlack(["install-skill"], { HOME: home, COPILOT_HOME: copilotHome }),
  ).toEqual({
    exitCode: 0,
    stdout: `Installed the toy-box-slack skill at ${path}.

Copilot reads skills when a lead's session starts or resumes, so a lead that's already running may not see it until later. Until then, its routines carry what each run needs.

It went there because COPILOT_HOME is set, so leads find it only if Toy Box runs with the same COPILOT_HOME.
`,
    stderr: "",
  });
  expect(await Bun.file(path).text()).toBe(await Bun.file(SKILL).text());
  expect(existsSync(join(home, ".copilot"))).toBe(false);
});

test("refuses a relative COPILOT_HOME on stderr with exit 1, installing nothing", async () => {
  const home = createTestFolder();

  expect(await runToyBoxSlack(["install-skill"], { HOME: home, COPILOT_HOME: "copilot" })).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `COPILOT_HOME must be an absolute path, but it's "copilot".\n`,
  });
  expect(existsSync(join(home, ".copilot"))).toBe(false);
});

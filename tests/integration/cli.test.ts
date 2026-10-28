// The CLI in its own process, the way a lead runs it, with only the environment each test gives it.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { MALLORY, connectedBridge } from "./connectedBridge";
import { startLinkedBridge, storeNewRequest } from "./linkedBridge";

const CLI = join(import.meta.dir, "..", "..", "cli", "index.ts");
const SKILL = join(import.meta.dir, "..", "..", "skills", "toy-box-slack", "SKILL.md");

/**
 * Runs `toy-box-slack <args>` with `env` and `PATH` as its whole environment, and a home folder
 * of its own unless `env` names one. It reads `stdin`, or nothing as in an agent's shell. Resolves
 * once it exits, with what it printed.
 */
async function runToyBoxSlack(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: createTestFolder(), ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
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

/** What the CLI prints when no bridge listens for `home`, as text or with --json. */
function noBridge(home: string, asJson = false) {
  const error = `No bridge is running for ${join(home, ".toy-box-slack")}, so \`status\` didn't run. Start it with \`toy-box-slack serve\`.`;
  return asJson
    ? { exitCode: 2, stdout: `${JSON.stringify({ error }, null, 2)}\n`, stderr: "" }
    : { exitCode: 2, stdout: "", stderr: `${error}\n` };
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

test("prints the lead's inbox on stdout with exit 0, or its result with --json", async () => {
  const { channelId, home } = await startLinkedBridge({ prepare: storeNewRequest });
  const lead = { HOME: home, COPILOT_AGENT_SESSION_ID: channelId };

  const json = await runToyBoxSlack(["inbox", "--json"], lead);
  expect(json).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(json.stdout)).toMatchObject({
    channel: "#C-link",
    requests: [{ id: 1, state: "open" }],
  });

  const text = await runToyBoxSlack(["inbox"], lead);
  expect(text).toMatchObject({ exitCode: 0, stderr: "" });
  expect(text.stdout).toStartWith("1 request in #C-link waits on you.\n\n### r1 · U-owner asked ");
  expect(text.stdout).toEndWith(
    'Answer each in its thread by piping your Markdown to `toy-box-slack reply r1`, or end one that needs no answer with `toy-box-slack dismiss r1 --reason "<why>"`.\n',
  );
}, 15_000);

test("reply reads its text from stdin, and says to write it there when there's none", async () => {
  const { channelId, home, inbox } = await startLinkedBridge({
    allowed: ["U-owner"],
    prepare: storeNewRequest,
  });
  const lead = { HOME: home, COPILOT_AGENT_SESSION_ID: channelId };
  await inbox();

  expect(await runToyBoxSlack(["reply", "r1"], lead)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      "`reply` didn't run. --text: Write the text on stdin, such as with a heredoc. Run `toy-box-slack reply --help` to see what it takes.\n",
  });
  expect(await runToyBoxSlack(["reply", "r1"], lead, "It's **fixed**.\n")).toEqual({
    exitCode: 0,
    stdout: "Queued o1 to answer r1 in its thread. If it can't post, inbox shows r1 again.\n",
    stderr: "",
  });
}, 15_000);

test("allow shows who it adds and takes the owner's passphrase on stdin, as set at the time", async () => {
  const { channelId, home, slack } = await connectedBridge();
  slack.setUser({
    id: MALLORY,
    team_id: "T-home",
    real_name: "Mallory",
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
  });
  const owner = { HOME: home };
  const passphrase = (typed: string) => runToyBoxSlack(["passphrase"], owner, typed);
  const allow = (typed: string) =>
    runToyBoxSlack(["allow", MALLORY, "--channel", channelId], owner, typed);
  const shown = `Allowing them would let them ask the lead to act, from #C-link:\n\n- Mallory (${MALLORY})\n\n`;

  expect(await allow("first\n")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${shown}No passphrase is set, so nothing can widen access. Run \`toy-box-slack passphrase\` at a terminal first.\n`,
  });
  expect(await passphrase("first\nfirst\n")).toEqual({
    exitCode: 0,
    stdout: "Set the owner's passphrase.\n",
    stderr: "",
  });
  // Changing it needs the old one, so a lead that runs passphrase can't replace it.
  expect(await passphrase("guess\nmine\nmine\n")).toMatchObject({ exitCode: 1 });
  expect(await passphrase("first\nsecond\nsecond\n")).toMatchObject({ exitCode: 0 });
  expect(await allow("first\n")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${shown}That isn't the owner's passphrase, so nothing changed.\n`,
  });
  expect(await allow("second\n")).toEqual({
    exitCode: 0,
    stdout: "They can all ask the lead to act, from #C-link.\n",
    stderr: shown,
  });
}, 15_000);

test("refuses a session that doesn't lead a linked channel, with exit 1", async () => {
  const { home } = await startLinkedBridge();
  const stranger = { HOME: home, COPILOT_AGENT_SESSION_ID: "session-elsewhere" };
  const error =
    "This session isn't the lead of a Toy Box channel linked to Slack, so it can't use toy-box-slack. If you lead a channel whose link was removed, delete its routines that run toy-box-slack.";

  expect(await runToyBoxSlack(["status"], stranger)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${error}\n`,
  });
  expect(await runToyBoxSlack(["status", "--json"], stranger)).toEqual({
    exitCode: 1,
    stdout: `${JSON.stringify({ error }, null, 2)}\n`,
    stderr: "",
  });
}, 15_000);

test("exits 2 when no bridge is running for its data folder", async () => {
  const home = createTestFolder();

  expect(await runToyBoxSlack(["status"], { HOME: home })).toEqual(noBridge(home));
  expect(await runToyBoxSlack(["status", "--json"], { HOME: home })).toEqual(noBridge(home, true));
});

test("exits 2 once the bridge stops, and once it's killed and leaves its socket behind", async () => {
  const { bridge, home, socket, serve } = await startLinkedBridge();
  bridge.child.kill("SIGTERM");
  expect(await bridge.exit()).toMatchObject({ code: 0 });

  expect(existsSync(socket)).toBe(false);
  expect(await runToyBoxSlack(["status"], { HOME: home })).toEqual(noBridge(home));

  const killed = await serve({});
  killed.child.kill("SIGKILL");
  await killed.exit();

  expect(existsSync(socket)).toBe(true);
  expect(await runToyBoxSlack(["status"], { HOME: home })).toEqual(noBridge(home));
}, 20_000);

test("installs the skill it ships into ~/.copilot/skills, and says when leads see it", async () => {
  const home = createTestFolder();
  const path = join(home, ".copilot", "skills", "toy-box-slack", "SKILL.md");

  expect(await runToyBoxSlack(["install-skill"], { HOME: home })).toEqual({
    exitCode: 0,
    stdout: `Installed the toy-box-slack skill at ${path}.

Copilot reads skills when a lead's session starts or resumes, so a lead that's already running may not see it yet. To set one up now, ask it to read ${path}.
`,
    stderr: "",
  });
  expect(await Bun.file(path).text()).toBe(await Bun.file(SKILL).text());
});

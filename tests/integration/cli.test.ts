// The CLI in its own process, the way a lead runs it, with only the environment each test gives it.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { started } from "./bridgeProcess";
import { startLinkedBridge, storeNewRequest } from "./linkedBridge";

const CLI = join(import.meta.dir, "..", "..", "cli", "index.ts");

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

  // Run through the file's own shebang, the way a shell runs the installed CLI, with the Bun
  // running these tests first on PATH.
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

  expect(stderr).toBe(started(home));
  expect(await child.exited).toBe(0);
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

test("refuses add-app without a terminal, even when stdin holds both tokens", async () => {
  const home = createTestFolder();

  const tokens = "xoxb-releases\nxapp-releases\n";
  expect(await runToyBoxSlack(["add-app", "releases"], { HOME: home }, tokens)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Only the owner at a terminal runs `add-app`.\n",
  });
  expect(existsSync(join(home, ".toy-box-slack"))).toBe(false);
});

test("exits 2 when no bridge is running for its data folder, even once a killed one leaves its socket", async () => {
  const home = createTestFolder();
  expect(await runToyBoxSlack(["status"], { HOME: home })).toEqual(noBridge(home));
  expect(await runToyBoxSlack(["status", "--json"], { HOME: home })).toEqual(noBridge(home, true));

  const { bridge, home: killedHome, socket } = await startLinkedBridge();
  bridge.child.kill("SIGKILL");
  await bridge.exit();

  expect(existsSync(socket)).toBe(true);
  expect(await runToyBoxSlack(["status"], { HOME: killedHome })).toEqual(noBridge(killedHome));
}, 15_000);

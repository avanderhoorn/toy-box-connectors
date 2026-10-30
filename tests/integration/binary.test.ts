// The CLI as npm installs it: the compiled binary, run through the launcher npm links onto PATH, in a
// lead's shell, where Toy Box sets BUN_BE_BUN.

import { expect, onTestFinished, test } from "bun:test";
import { copyFileSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { BUNDLED_SKILL } from "@commands/client/skill";
import { installedSkill, startSlackForBridge, started } from "./bridgeProcess";
import { waitFor } from "./waitFor";

const REPOSITORY = join(import.meta.dir, "..", "..");

/**
 * Builds the binary with `bun run build` beside a copy of the launcher, the way npm unpacks the
 * package, and links the launcher from a bin folder of its own, the way npm links its command.
 * Returns the link.
 */
async function installCli() {
  const unpacked = createTestFolder();
  const outfile = join(unpacked, "toy-box-slack-darwin-arm64");
  const build = Bun.spawn([process.execPath, "run", "build", "--outfile", outfile], {
    cwd: REPOSITORY,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  copyFileSync(join(REPOSITORY, "toy-box-slack"), join(unpacked, "toy-box-slack"));

  const bin = createTestFolder();
  symlinkSync(join(unpacked, "toy-box-slack"), join(bin, "toy-box-slack"));
  return join(bin, "toy-box-slack");
}

/** The environment of a lead's shell, with `home` as its home folder and `env` besides. */
function leadShell(home: string, env: Record<string, string>) {
  return { PATH: process.env.PATH, HOME: home, BUN_BE_BUN: "1", ...env };
}

test("serves from a project folder with the skill it carries, ignoring the folder's .env and bunfig.toml", async () => {
  const toyBoxSlack = await installCli();
  const home = createTestFolder();
  const project = createTestFolder();
  writeFileSync(join(project, ".env"), "TOY_BOX_URL=http://toy-box.example.com:3000\n");
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(project, "preload.ts"), 'console.error("bunfig.toml preloaded this");\n');
  const { slack, env } = startSlackForBridge();

  const child = Bun.spawn([toyBoxSlack, "serve"], {
    cwd: project,
    env: leadShell(home, env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  onTestFinished(() => child.kill("SIGKILL"));
  let stderr = "";
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
  })();
  await waitFor(() => expect(stderr).toContain("Connected to Slack."), 10_000);

  // An acked event proves Socket Mode works inside the binary both ways.
  const sent = slack.sendEvent({ type: "message", channel: "C-link", ts: "1700000200.000100" });
  expect(await slack.waitForAck(sent.envelopeId, 5_000)).not.toBeNull();
  expect(readFileSync(installedSkill(home), "utf8")).toBe(BUNDLED_SKILL);
  child.kill("SIGTERM");

  expect(await child.exited).toBe(0);
  await drained;
  expect(stderr).toBe(
    `${started(home)}Connected to Slack.\ntoy-box-slack is stopping after SIGTERM\n`,
  );
}, 15_000);

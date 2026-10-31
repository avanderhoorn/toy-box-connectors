// The CLI in its own process, the way a lead runs it, with only the environment each test gives it.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandSocketPath } from "@bridge/server/socket";
import { createTestFolder } from "@bridge/server/testFixtures";
import { MAX_IMAGE_BYTES } from "@commands/model";
import { runToyBoxSlack, started } from "./bridgeProcess";
import { startLinkedBridge, storeNewRequest } from "./linkedBridge";

const CLI = join(import.meta.dir, "..", "..", "cli", "index.ts");

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

/** A bridge on `folder`'s socket that answers every call, and the inputs it was called with. */
function answeringBridge(folder: string): unknown[] {
  const inputs: unknown[] = [];
  const bridge = Bun.serve({
    unix: commandSocketPath(folder),
    async fetch(request) {
      inputs.push(((await request.json()) as { input: unknown }).input);
      return Response.json({ result: {}, text: "Queued." });
    },
  });
  onTestFinished(() => bridge.stop(true));
  return inputs;
}

test("reply sends only the options it was given, so a bridge of another release isn't sent one it doesn't take", async () => {
  const folder = createTestFolder();
  const inputs = answeringBridge(folder);

  const answer = await runToyBoxSlack(
    ["reply", "r1"],
    { TOY_BOX_SLACK_HOME: folder, COPILOT_AGENT_SESSION_ID: "toybox-link" },
    "Fixed.\n",
  );

  expect(answer.exitCode).toBe(0);
  expect(inputs).toEqual([{ request: "r1", text: "Fixed.\n" }]);
});

test("refuses an option the command doesn't take, before it reads a file or the bridge hears of it", async () => {
  const folder = createTestFolder();
  const inputs = answeringBridge(folder);
  const lead = { TOY_BOX_SLACK_HOME: folder, COPILOT_AGENT_SESSION_ID: "toybox-link" };

  expect(await runToyBoxSlack(["post", "--threads", "r14"], lead, "Shipped.\n")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      "`post` didn't run. It doesn't take --threads. Run `toy-box-slack post --help` to see what it takes.\n",
  });
  expect(
    await runToyBoxSlack(
      ["reply", "r1", "--image", join(folder, "chart.png"), "--alt", "A chart", "--imgae", "x"],
      lead,
      "Here.\n",
    ),
  ).toMatchObject({
    stderr: `\`reply\` didn't run. It doesn't take --imgae. Run \`toy-box-slack reply --help\` to see what it takes.\n`,
  });
  // Each shows once however often it repeats, and a positional is no option, nor is a camelCase
  // spelling `--help` doesn't show.
  expect(
    await runToyBoxSlack(["reply", "--request", "r1", "--imgae", "x", "--request", "r2"], lead),
  ).toMatchObject({
    stderr: `\`reply\` didn't run. It doesn't take --request or --imgae. Run \`toy-box-slack reply --help\` to see what it takes.\n`,
  });
  expect(await runToyBoxSlack(["link", "--slackChannel", "C1"], lead)).toMatchObject({
    stderr: `\`link\` didn't run. It doesn't take --slackChannel. Run \`toy-box-slack link --help\` to see what it takes.\n`,
  });
  expect(inputs).toEqual([]);
});

test("reply refuses an --image it can't read or that's over 5 MiB, without calling the bridge", async () => {
  const folder = createTestFolder();
  const missing = join(folder, "chart.png");
  const huge = join(folder, "screenshot.png");
  writeFileSync(huge, new Uint8Array(MAX_IMAGE_BYTES + 1));
  const largest = join(folder, "photo.png");
  writeFileSync(largest, new Uint8Array(MAX_IMAGE_BYTES));

  const images = [missing, huge, largest].flatMap((path) => ["--image", path, "--alt", "A chart"]);
  expect(await runToyBoxSlack(["reply", "r1", ...images], {}, "Here.\n")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `\`reply\` didn't run. --image: \`${missing}\` can't be read. --image: \`${huge}\` is over 5 MiB. Run \`toy-box-slack reply --help\` to see what it takes.\n`,
  });
});

test("post reads the thread it names, and whom to mention as one option, by member IDs separated by commas", async () => {
  const { channelId, home } = await startLinkedBridge({ allowed: ["U0ALICE", "U0BOB"] });
  const lead = { HOME: home, COPILOT_AGENT_SESSION_ID: channelId };

  expect(
    await runToyBoxSlack(["post", "--mention", "U0ALICE, U0BOB"], lead, "Shipped **1.2**.\n"),
  ).toEqual({
    exitCode: 0,
    stdout: "Queued o1 in #C-link, mentioning U0ALICE and U0BOB.\n",
    stderr: "",
  });
  expect(await runToyBoxSlack(["post", "--thread", "o9"], lead, "Shipped **1.2**.\n")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Nothing posted. This channel has no post o9.\n",
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

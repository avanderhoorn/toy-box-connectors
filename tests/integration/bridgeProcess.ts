// The bridge as its own process, started in the background or at a terminal, and the owner's other
// terminal commands.

import { onTestFinished } from "bun:test";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { startFakeSlack, type FakeSlackIdentity } from "../fakes/slack";

const REPOSITORY = join(import.meta.dir, "..", "..");
const CLI = [process.execPath, "--no-env-file", "cli/index.ts"];

/** How to kill each bridge or terminal tests started that may still be running. */
const bridges = new Set<() => void>();

/** Kills every bridge and terminal a test started, as the test finishes. */
function killBridges() {
  for (const kill of bridges) kill();
  bridges.clear();
}

/** Where `serve` installs the skill when `home` is its home folder. */
export function installedSkill(home: string) {
  return join(home, ".copilot", "skills", "toy-box-slack", "SKILL.md");
}

/** What a bridge whose home folder is `home` writes to stderr as it starts, up to saying it runs. */
export function started(home: string) {
  const running = `toy-box-slack is running for ${join(home, ".toy-box-slack")}`;
  return `Installed the toy-box-slack skill at ${installedSkill(home)}.\n${running}\n`;
}

/**
 * Run `toy-box-slack serve` in the background with `home` as its home folder and only `env`
 * besides, collecting what it writes to stderr. It reads `stdin`, or nothing, and never a terminal.
 */
export function spawnBridge(home: string, env: Record<string, string> = {}, stdin?: Blob) {
  // Bun throws outside a running test, so a test that timed out starts no bridge it can't stop.
  onTestFinished(killBridges);
  const child = Bun.spawn([...CLI, "serve"], {
    cwd: REPOSITORY,
    env: environment(home, env),
    stdin: stdin ?? "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  bridges.add(() => child.kill("SIGKILL"));

  let stderr = "";
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
  })();

  return {
    child,
    /** Resolves once the bridge says it's running, and rejects if it exits or takes too long. */
    async running() {
      const deadline = Date.now() + 10_000;
      while (!stderr.includes("toy-box-slack is running")) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`The bridge didn't start:\n${stderr}`);
        }
        await Bun.sleep(10);
      }
    },
    async exit() {
      const code = await child.exited;
      await drained;
      return { code, stderr };
    },
  };
}

/**
 * Run `toy-box-slack <args>` at a terminal of its own, the way the owner runs `serve` or `add-app`,
 * with `home` as its home folder and only `env` besides. `script` gives it the terminal, copies
 * everything the terminal shows to the test and exits as the command does, with its exit code.
 * `cat` passes on what the test types, since `script` can't read from a socket, and is never done,
 * since `script` would send the command an end of input.
 */
export function runAtTerminal(home: string, args: string[], env: Record<string, string> = {}) {
  onTestFinished(killBridges);
  const shell = ["bash", "-c", 'exec script -q /dev/null "$@" < <(exec cat)', "bash"];
  const terminal = Bun.spawn([...shell, ...CLI, ...args], {
    cwd: REPOSITORY,
    env: environment(home, env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    // A process group of its own, so killing the group closes the terminal, which hangs up on the
    // command.
    detached: true,
  });
  bridges.add(() => {
    try {
      process.kill(-terminal.pid, "SIGKILL");
    } catch {
      // It exited on its own.
    }
  });

  let shown = "";
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of terminal.stdout) shown += decoder.decode(chunk, { stream: true });
  })();
  /** What the terminal showed, colors and all, with a file's line endings. */
  const transcript = () => shown.replaceAll("\r\n", "\n");

  return {
    /** Resolves once the terminal shows `text`, and rejects if the command exits or takes too long. */
    async shows(text: string) {
      const deadline = Date.now() + 10_000;
      while (!transcript().includes(text)) {
        if (terminal.exitCode !== null || Date.now() > deadline) {
          throw new Error(`The terminal didn't show ${JSON.stringify(text)}:\n${transcript()}`);
        }
        await Bun.sleep(10);
      }
    },
    /** Types `line` and presses Return. */
    async type(line: string) {
      await terminal.stdin.write(`${line}\r`);
      await terminal.stdin.flush();
    },
    /** Presses Ctrl-C. */
    async interrupt() {
      await terminal.stdin.write("\x03");
      await terminal.stdin.flush();
    },
    /** Waits for the command to exit, and returns its exit code and everything the terminal showed. */
    async exit() {
      const code = await terminal.exited;
      await terminal.stdin.end();
      await drained;
      return { code, transcript: transcript() };
    },
  };
}

/**
 * A fake Slack whose tokens belong to `identity`, or else the fake's own workspace and app, with the
 * channel C-link a linked bridge watches, and the environment that points a bridge at it with both
 * tokens.
 */
export function startSlackForBridge(identity?: Partial<FakeSlackIdentity>) {
  // Pages of one prove the bridge reads every page of whatever it lists.
  const slack = startFakeSlack({ identity, pageSize: 1 });
  // Bun runs a test's finish hooks in order and skips the rest once one throws, as this fake's stop
  // does when it saw unexpected traffic, so the bridges die before it stops.
  onTestFinished(() => {
    killBridges();
    return slack.stop();
  });
  slack.addChannel({ id: "C-link" });
  const env = {
    SLACK_API_URL: slack.url,
    SLACK_BOT_TOKEN: slack.botToken,
    SLACK_APP_TOKEN: slack.appToken,
  };
  return { slack, env };
}

/**
 * The environment `serve` runs in: `PATH`, its home and data folders, and `env`, so nothing from the
 * shell running the tests reaches it.
 */
function environment(home: string, env: Record<string, string>) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TOY_BOX_SLACK_HOME: join(home, ".toy-box-slack"),
    ...env,
  };
}

/** Opens the data folder's database for `use` while no bridge holds it. */
export async function withDatabase<T>(
  dataFolder: string,
  use: (database: BridgeDatabase) => Promise<T>,
): Promise<T> {
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    return await use(database);
  } finally {
    await database.close();
  }
}

// A real Toy Box that end-to-end tests own.
//
// It runs the built `toy-box` binary on 127.0.0.1:3199 under a temp HOME, so its database, its
// sessions, the skills its lead finds and its Copilot CLI's state never touch the owner's. Agent
// shells set variables that point Toy Box at the owner's server and session, so Toy Box runs in a
// scrubbed environment, which is also the only place its Copilot token goes. The port is fixed, so
// one runs at a time.

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { readCommandLog, type CommandRun } from "./commandLog";

/** The model every test lead runs. A claude-haiku-4.5 lead failed its tool calls. */
export const LEAD_MODEL = { provider: "copilot", name: "claude-sonnet-5" } as const;

/** How long Toy Box can take to answer with its models, which waits on its Copilot CLI. */
export const STARTUP_TIMEOUT = 120_000;

/** How long stopping can take, from SIGTERM through checking that nothing outlived SIGKILL. */
export const STOP_TIMEOUT = 15_000;

const ORIGIN = new URL("http://127.0.0.1:3199");
const REPOSITORY = join(import.meta.dir, "..", "..");

// Agent shells set these, and each points Toy Box, its Copilot CLI or the lead's shell at the
// owner's server, session, credentials or state.
const OWNER_VARIABLES =
  /^(BUN_BE_BUN|NITRO_\w+|COPILOT_\w+|GH_\w+|GITHUB_\w+|SSH_\w+|SLACK_\w+|TOY_BOX_\w+|XDG_\w+)$/;

/** Commands to put on the lead's PATH, each with the command line it runs. An empty one only records. */
export type Commands = Record<string, readonly string[]>;

export type IsolatedToyBoxOptions = {
  /** Skills installed as `~/.copilot/skills/<name>/SKILL.md` before any channel exists. */
  skills?: Record<string, string>;
  /** Commands besides the CLI under test, which is always on PATH. */
  commands?: Commands;
};

export type IsolatedToyBox = {
  origin: URL;
  /** The temp HOME Toy Box, its Copilot CLI and the lead's shell share. */
  home: string;
  /** Toy Box's working folder, which test channels use as their directory. */
  work: string;
  /** Aborts as Toy Box stops, ending whatever follows it. */
  signal: AbortSignal;
  /** Every command the lead ran from PATH, oldest first. */
  commandRuns(): CommandRun[];
  /** `error`, with where to read what happened. The run's folder stays for it. */
  failure(error: unknown): Error;
  /** Stops Toy Box and every process it started, then removes the run's folder unless a run failed. */
  stop(): Promise<void>;
};

/** A failure that already says where to read what happened. */
class EndToEndFailure extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "EndToEndFailure";
  }
}

/** Starts Toy Box under a temp HOME, and resolves once it offers the lead's model. */
export async function startIsolatedToyBox(
  options: IsolatedToyBoxOptions = {},
): Promise<IsolatedToyBox> {
  await refuseTakenPort();
  const binary = toyBoxBinary();
  const token = copilotToken();
  const root = realpathSync(mkdtempSync("/tmp/tbs-e2e-"));
  const [home, bin, work] = ["home", "bin", "work"].map((name) => join(root, name));
  for (const folder of [home, bin, work]) mkdirSync(folder);
  const log = join(root, "toy-box.log");
  const commandLog = join(root, "commands.jsonl");
  installSkills(home, options.skills ?? {});
  installCommands(bin, commandLog, options.commands ?? {});

  const output = openSync(log, "a");
  const server = Bun.spawn(
    [binary, "--port", ORIGIN.port, "--host", ORIGIN.hostname, "--no-open"],
    {
      cwd: work,
      env: isolatedEnvironment(process.env, { home, bin, token }),
      stdin: "ignore",
      stdout: output,
      stderr: output,
    },
  );
  closeSync(output);

  const lifetime = new AbortController();
  let keep = false;
  let stopped: Promise<void> | undefined;
  const toyBox: IsolatedToyBox = {
    origin: ORIGIN,
    home,
    work,
    signal: lifetime.signal,
    commandRuns: () => readCommandLog(commandLog),
    failure(error) {
      keep = true;
      if (error instanceof EndToEndFailure) return error;
      const message = error instanceof Error ? error.message : String(error);
      const transcripts = sessionTranscripts(home).map((path) => `Transcript: ${path}`);
      return new EndToEndFailure(
        [
          message,
          `Kept the run's folder at ${root}.`,
          ...transcripts,
          "Toy Box's log ends with:",
          logTail(log, token),
        ].join("\n"),
        { cause: error },
      );
    },
    stop() {
      stopped ??= (async () => {
        lifetime.abort();
        try {
          await stopProcessTree(server);
        } catch (error) {
          throw toyBox.failure(error);
        } finally {
          // The Copilot CLI unpacks itself into the temp HOME's caches, a few hundred MB per run.
          if (keep) rmSync(join(home, "Library"), { recursive: true, force: true });
          else rmSync(root, { recursive: true, force: true });
        }
      })();
      return stopped;
    },
  };

  try {
    await waitUntilReady(server);
    return toyBox;
  } catch (error) {
    const failure = toyBox.failure(error);
    await toyBox.stop().catch((stopFailure: unknown) => console.error(stopFailure));
    throw failure;
  }
}

/** Resolves with `check`'s first result other than undefined. A check that throws fails at once. */
export async function waitUntil<T>(
  what: string,
  check: () => T | undefined,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`Waited ${timeout / 1000} s for ${what}.`);
    await Bun.sleep(50);
  }
}

/** The environment Toy Box runs in: the parent's without what points at the owner, under `home`. */
export function isolatedEnvironment(
  parent: Record<string, string | undefined>,
  { home, bin, token }: { home: string; bin: string; token: string },
): Record<string, string> {
  const kept = Object.entries(parent).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !OWNER_VARIABLES.test(entry[0]),
  );
  return {
    ...Object.fromEntries(kept),
    HOME: home,
    PATH: parent.PATH ? `${bin}:${parent.PATH}` : bin,
    COPILOT_GITHUB_TOKEN: token,
  };
}

/**
 * Writes the CLI under test and `commands` into `bin`. Each runs its command line, if it has one,
 * then records the run in `log`, and exits as the command line did.
 */
export function installCommands(bin: string, log: string, commands: Commands) {
  const cli = [process.execPath, join(REPOSITORY, "cli", "index.ts")];
  for (const [name, target] of Object.entries({ "toy-box-slack": cli, ...commands })) {
    const run = target.length ? `${target.map(shellQuote).join(" ")} "$@"\nstatus=$?` : "status=0";
    const record = [process.execPath, join(import.meta.dir, "commandLog.ts"), log, name]
      .map(shellQuote)
      .join(" ");
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${run}\n${record} "$status" "$@"\nexit "$status"\n`);
    chmodSync(path, 0o755);
  }
}

async function refuseTakenPort() {
  const answered = await fetch(ORIGIN, { redirect: "manual", signal: AbortSignal.timeout(2_000) })
    .then(async (response) => {
      await response.body?.cancel();
      return true;
    })
    .catch(() => false);
  if (answered) {
    throw new Error(
      `Something already answers at ${ORIGIN.origin}. Stop it before running the suite.`,
    );
  }
}

/** The built Toy Box: TOY_BOX_BINARY, or the one in the toy-box checkout beside this repository. */
function toyBoxBinary(): string {
  const binary = process.env.TOY_BOX_BINARY ?? join(checkoutsFolder(), "toy-box", "toy-box");
  if (!existsSync(binary)) {
    throw new Error(`There's no built Toy Box at ${binary}. Build it, or set TOY_BOX_BINARY.`);
  }
  return binary;
}

// A worktree sits elsewhere, so the main checkout comes from the repository's shared git folder.
function checkoutsFolder(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: REPOSITORY,
  });
  return dirname(dirname(git.stdout.toString().trim()));
}

/** The owner's GitHub token, which Toy Box's Copilot CLI signs in with. */
function copilotToken(): string {
  const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const token = result.stdout.toString().trim();
  if (!result.success || !token) {
    throw new Error("`gh auth token` gave no token. Sign in with `gh auth login` first.");
  }
  return token;
}

function installSkills(home: string, skills: Record<string, string>) {
  for (const [name, text] of Object.entries(skills)) {
    const folder = join(home, ".copilot", "skills", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), text);
  }
}

const modelListSchema = z.object({
  models: z.array(z.object({ id: z.string(), provider: z.string() })),
});

// Toy Box answers GET /api/v1/models once its Copilot CLI has listed what the token can use, so
// the first answer is final.
async function waitUntilReady(server: Subprocess) {
  const deadline = Date.now() + STARTUP_TIMEOUT;
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Toy Box exited with ${server.signalCode ?? server.exitCode} as it started.`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Toy Box didn't answer with its models within ${STARTUP_TIMEOUT / 1000} s.`);
    }
    const models = await fetchModels(deadline);
    if (models) {
      const offered = models.some(
        ({ id, provider }) => id === LEAD_MODEL.name && provider === LEAD_MODEL.provider,
      );
      if (offered) return;
      throw new Error(
        models.length
          ? `Toy Box doesn't offer ${LEAD_MODEL.provider}'s ${LEAD_MODEL.name}.`
          : "Toy Box offers no models, so Copilot didn't accept the token from `gh auth token`.",
      );
    }
    await Bun.sleep(250);
  }
}

async function fetchModels(deadline: number) {
  try {
    const response = await fetch(new URL("/api/v1/models", ORIGIN), {
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return undefined;
    }
    return modelListSchema.parse(await response.json()).models;
  } catch {
    // Toy Box refuses connections until it listens.
    return undefined;
  }
}

function sessionTranscripts(home: string): string[] {
  const sessions = join(home, ".copilot", "session-state");
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions)
    .map((session) => join(sessions, session, "events.jsonl"))
    .filter((path) => existsSync(path));
}

function logTail(log: string, token: string): string {
  if (!existsSync(log)) return "";
  return readFileSync(log, "utf8")
    .replaceAll(token, "<COPILOT_GITHUB_TOKEN>")
    .trimEnd()
    .split("\n")
    .slice(-40)
    .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
    .join("\n");
}

type ProcessEntry = { pid: number; started: string };

/**
 * Ends `server` and everything it started. Its children outlive it as orphans, so the harness
 * reads its process tree before stopping it, and tells a process from a later one that reuses its
 * pid by when it started.
 */
async function stopProcessTree(server: Subprocess) {
  const tree = processTree(server.pid);
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(STOP_TIMEOUT - 5_000)]);
  // Whatever is left goes, along with anything it started since the tree was read.
  const left = running(tree).flatMap(({ pid }) => processTree(pid));
  for (const { pid } of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It exited on its own.
    }
  }
  await waitUntil(
    "Toy Box's processes to exit",
    () => (running(left).length ? undefined : true),
    5_000,
  ).catch(() => {
    const pids = running(left).map(({ pid }) => pid);
    throw new Error(`Processes Toy Box started outlived SIGKILL: ${pids.join(", ")}.`);
  });
}

function running(entries: readonly ProcessEntry[]): ProcessEntry[] {
  const table = processTable();
  return entries.filter(({ pid, started }) => table.get(pid)?.started === started);
}

function processTree(root: number): ProcessEntry[] {
  const table = processTable();
  const tree: ProcessEntry[] = [];
  const pending = [root];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    const entry = table.get(pid);
    if (!entry) continue;
    tree.push({ pid, started: entry.started });
    for (const [child, { ppid }] of table) if (ppid === pid) pending.push(child);
  }
  return tree;
}

function processTable(): Map<number, { ppid: number; started: string }> {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,lstart="]);
  const table = new Map<number, { ppid: number; started: string }>();
  for (const line of ps.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), started: match[3] });
  }
  return table;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

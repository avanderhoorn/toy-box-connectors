// A real Toy Box that end-to-end tests own.
//
// It runs the built `toy-box` binary on 127.0.0.1:3199 under a temp HOME, so its database, its
// sessions, the skills its lead finds and its Copilot CLI's state never touch the owner's. Agent
// shells set variables that point Toy Box at the owner's server and session, so Toy Box runs in a
// scrubbed environment, which is also the only place its Copilot token goes. Before it starts, the
// CLI under test goes on its PATH and its skill goes where `serve` installs an owner's, since the
// lead adds its routine before the bridge first serves. The port is fixed, so one runs at a time.

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { installSkill } from "@commands/client/skill";

/** The model every test lead runs. A claude-haiku-4.5 lead failed its tool calls. */
export const LEAD_MODEL = { provider: "copilot", name: "claude-sonnet-5" } as const;

/** How long Toy Box can take to answer with its models, which waits on its Copilot CLI. */
export const STARTUP_TIMEOUT = 120_000;

/** How long stopping can take, from SIGTERM through checking that nothing outlived SIGKILL. */
export const STOP_TIMEOUT = 15_000;

const ORIGIN = new URL("http://127.0.0.1:3199");
const REPOSITORY = join(import.meta.dir, "..", "..");
/** The CLI under test, which the lead runs from PATH. */
export const CLI = join(REPOSITORY, "cli", "index.ts");

// Agent shells set these, and each points Toy Box, its Copilot CLI or the lead's shell at the
// owner's server, session, credentials or state.
const OWNER_VARIABLES =
  /^(BUN_BE_BUN|NITRO_\w+|COPILOT_\w+|GH_\w+|GITHUB_\w+|SSH_\w+|SLACK_\w+|TOY_BOX_\w+|XDG_\w+)$/;

export type IsolatedToyBox = {
  origin: URL;
  /** The run's folder. A failure ends with the tail of each `.log` file in it. */
  folder: string;
  /** The temp HOME Toy Box, its Copilot CLI and the lead's shell share. */
  home: string;
  /** Toy Box's working folder, which test channels use as their directory. */
  work: string;
  /** Aborts as Toy Box stops, ending whatever follows it. */
  signal: AbortSignal;
  /** `error`, with where to read what happened. The run's folder stays for it. */
  failure(error: unknown): Error;
  /** Stops Toy Box and every process it started, then removes the run's folder unless a run failed. */
  stop(): Promise<void>;
};

/** Starts Toy Box under a temp HOME, and resolves once it offers the lead's model. */
export async function startIsolatedToyBox(): Promise<IsolatedToyBox> {
  await refuseTakenPort();
  const binary = toyBoxBinary();
  const token = copilotToken();
  const root = realpathSync(mkdtempSync("/tmp/tbs-e2e-"));
  const [home, bin, work] = ["home", "bin", "work"].map((name) => join(root, name));
  for (const folder of [home, bin, work]) mkdirSync(folder);
  const log = join(root, "toy-box.log");
  // The lead runs the CLI from source through this link, whose shebang runs it with the Bun on PATH.
  symlinkSync(CLI, join(bin, "toy-box-slack"));
  installSkill({}, home);

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
  const toyBox: IsolatedToyBox = {
    origin: ORIGIN,
    folder: root,
    home,
    work,
    signal: lifetime.signal,
    failure(error) {
      keep = true;
      const message = error instanceof Error ? error.message : String(error);
      const transcripts = sessionTranscripts(home).map((path) => `Transcript: ${path}`);
      const logs = readdirSync(root)
        .filter((name) => name.endsWith(".log"))
        .sort()
        .map((name) => join(root, name));
      return new Error(
        [
          message,
          `Kept the run's folder at ${root}.`,
          ...transcripts,
          ...logs.flatMap((path) => [`${path} ends with:`, logTail(path, token)]),
        ].join("\n"),
        { cause: error },
      );
    },
    async stop() {
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
  check: () => T | undefined | Promise<T | undefined>,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
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
 * Runs `toy-box-slack <args>` at a terminal under `home` as its owner, and fails with what it
 * printed unless it exits 0.
 */
export async function runCli(home: string, args: string[]) {
  const cli = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `\`toy-box-slack ${args.join(" ")}\` exited with ${exitCode}.\n${stderr}${stdout}`,
    );
  }
}

async function refuseTakenPort() {
  const answer = await fetch(ORIGIN, {
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  await answer?.body?.cancel();
  if (answer) {
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

const modelListSchema = z.object({
  models: z.array(z.object({ id: z.string(), provider: z.string() })),
});

// Toy Box answers GET /api/v1/models once its Copilot CLI has listed what the token can use, so
// the first answer is final. A channel asking for a model Toy Box doesn't offer gets another.
async function waitUntilReady(server: Subprocess) {
  const deadline = Date.now() + STARTUP_TIMEOUT;
  const models = await waitUntil(
    "Toy Box to answer with its models",
    async () => {
      const exit = server.signalCode ?? server.exitCode;
      if (exit !== null) throw new Error(`Toy Box exited with ${exit} as it started.`);
      // Toy Box refuses connections until it listens.
      const response = await fetch(new URL("/api/v1/models", ORIGIN), {
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      }).catch(() => undefined);
      if (response?.status === 200) return modelListSchema.parse(await response.json()).models;
      await response?.body?.cancel();
      return undefined;
    },
    STARTUP_TIMEOUT,
  );
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

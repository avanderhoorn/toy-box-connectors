import { expect, onTestFinished, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";

const REPOSITORY = join(import.meta.dir, "..", "..");

/** Run `toy-box-slack serve` with `home` as its home folder, collecting what it writes to stderr. */
function spawnBridge(home: string) {
  const child = Bun.spawn([process.execPath, "cli/index.ts", "serve"], {
    cwd: REPOSITORY,
    env: { PATH: process.env.PATH, HOME: home, TOY_BOX_SLACK_HOME: join(home, ".toy-box-slack") },
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

/** Describe every entry in `folder` closely enough to notice any change to it. */
function snapshot(folder: string) {
  return {
    modified: statSync(folder).mtimeMs,
    entries: readdirSync(folder)
      .sort()
      .map((name) => {
        const path = join(folder, name);
        const { size, mode, mtimeMs } = statSync(path);
        const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
        return { name, size, mode, modified: mtimeMs, sha256 };
      }),
  };
}

test("a second bridge exits with a clear message and touches nothing", async () => {
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  const first = spawnBridge(home);
  await first.running();
  const before = snapshot(dataFolder);

  const second = await spawnBridge(home).exit();

  expect(second).toEqual({
    code: 1,
    stderr: `Another toy-box-slack bridge is already running for ${dataFolder}. Stop it before starting a new one.\n`,
  });
  expect(snapshot(dataFolder)).toEqual(before);

  first.child.kill("SIGTERM");
  expect(await first.exit()).toEqual({
    code: 0,
    stderr: `toy-box-slack is running for ${dataFolder}\ntoy-box-slack is stopping after SIGTERM\n`,
  });
}, 15_000);

test("a bridge that was killed leaves no lock behind", async () => {
  const home = createTestFolder();
  const killed = spawnBridge(home);
  await killed.running();
  killed.child.kill("SIGKILL");
  await killed.exit();

  const next = spawnBridge(home);
  await next.running();

  next.child.kill("SIGTERM");
  expect((await next.exit()).code).toBe(0);
}, 15_000);

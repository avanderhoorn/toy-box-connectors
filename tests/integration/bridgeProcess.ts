// The bridge as its own process, the way launchd runs it.

import { onTestFinished } from "bun:test";
import { join } from "node:path";

const REPOSITORY = join(import.meta.dir, "..", "..");

/**
 * Run `toy-box-slack serve` with `home` as its home folder, collecting what it writes to stderr.
 * Its environment holds only `PATH`, its home and data folders, and `env`, so nothing from the
 * shell running the tests reaches it.
 */
export function spawnBridge(home: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "cli/index.ts", "serve"], {
    cwd: REPOSITORY,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TOY_BOX_SLACK_HOME: join(home, ".toy-box-slack"),
      ...env,
    },
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

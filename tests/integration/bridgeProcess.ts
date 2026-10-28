// The bridge as its own process, the way launchd runs it.

import { onTestFinished } from "bun:test";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { startFakeSlack, type FakeSlackIdentity } from "../fakes/slack";

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

/**
 * A fake Slack whose tokens belong to `identity`, or else the fake's own workspace and app, with the
 * channel C-link a linked bridge watches, and the environment that points a bridge at it with both
 * tokens.
 */
export function startSlackForBridge(identity?: Partial<FakeSlackIdentity>) {
  // Pages of one prove the bridge reads every page of whatever it lists.
  const slack = startFakeSlack({ identity, pageSize: 1 });
  onTestFinished(() => slack.stop());
  slack.addChannel({ id: "C-link" });
  const env = {
    SLACK_API_URL: slack.url,
    SLACK_BOT_TOKEN: slack.botToken,
    SLACK_APP_TOKEN: slack.appToken,
  };
  return { slack, env };
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

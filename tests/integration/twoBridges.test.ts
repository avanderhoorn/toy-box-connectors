import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { createAddedApp, createTestFolder } from "@bridge/server/testFixtures";
import { spawnBridge, started } from "./bridgeProcess";

/** Describe every entry in `folder` closely enough to notice any change to it. */
function snapshot(folder: string) {
  return {
    modified: statSync(folder).mtimeMs,
    entries: readdirSync(folder)
      .sort()
      .map((name) => {
        const path = join(folder, name);
        const stats = statSync(path);
        // A socket can't be read, but one put in its place has another inode.
        const sha256 = stats.isSocket()
          ? null
          : new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
        const { size, mode, ino, mtimeMs } = stats;
        return { name, size, mode, inode: ino, modified: mtimeMs, sha256 };
      }),
  };
}

test("a bridge for an app another bridge hosts exits with a clear message and touches nothing", async () => {
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  const releases = createAddedApp(dataFolder, "releases");
  const first = spawnBridge(home);
  await first.running();
  const before = snapshot(releases.folder);

  const second = await spawnBridge(home, { TOY_BOX_SLACK_HOME: releases.folder }).exit();

  expect(second).toEqual({
    code: 1,
    stderr: `Another toy-box-slack bridge is already running for ${releases.folder}. Stop it before starting a new one.\n`,
  });
  expect(snapshot(releases.folder)).toEqual(before);

  first.child.kill("SIGTERM");
  expect(await first.exit()).toEqual({
    code: 0,
    stderr: `${started(home)}toy-box-slack is stopping after SIGTERM\n`,
  });
}, 15_000);

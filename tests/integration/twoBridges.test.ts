import { expect, onTestFinished, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { acquireBridgeLock } from "@bridge/server/lock";
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
    stderr: `${started(home)}toy-box-slack is stopping after SIGTERM\n`,
  });
}, 15_000);

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

test("a bridge that finds the lock taken stops before it creates bridge.db", async () => {
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  onTestFinished(() => lock.release());
  const before = snapshot(dataFolder);

  const refused = await spawnBridge(home).exit();

  expect(refused).toEqual({
    code: 1,
    stderr: `Another toy-box-slack bridge is already running for ${dataFolder}. Stop it before starting a new one.\n`,
  });
  expect(snapshot(dataFolder)).toEqual(before);
}, 15_000);

test("a bridge that was killed leaves no lock or socket in the next one's way", async () => {
  const home = createTestFolder();
  const killed = spawnBridge(home);
  await killed.running();
  killed.child.kill("SIGKILL");
  await killed.exit();
  expect(existsSync(join(home, ".toy-box-slack", "bridge.sock"))).toBe(true);

  const next = spawnBridge(home);
  await next.running();

  next.child.kill("SIGTERM");
  expect((await next.exit()).code).toBe(0);
}, 15_000);

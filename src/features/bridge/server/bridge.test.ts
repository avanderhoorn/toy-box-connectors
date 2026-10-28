import { expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "./bridge";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder } from "./testFixtures";

async function start(dataFolder: string) {
  const bridge = await startBridge(dataFolder);
  onTestFinished(() => bridge.stop());
  return bridge;
}

test("creates its data folder, lock and database on first start", async () => {
  const dataFolder = join(createTestFolder(), ".toy-box-slack");

  await start(dataFolder);

  expect(statSync(dataFolder).mode & 0o777).toBe(0o700);
  expect(readdirSync(dataFolder)).toEqual(expect.arrayContaining(["bridge.db", "bridge.lock"]));
});

test("refuses to start beside a running bridge and starts once that one stops", async () => {
  const dataFolder = createTestFolder();
  const first = await startBridge(dataFolder);

  await expect(startBridge(dataFolder)).rejects.toThrow(BridgeRefusedError);
  await first.stop();

  await start(dataFolder);
});

test("lets go of the lock when it can't open the database", async () => {
  const dataFolder = createTestFolder();
  const newer = new Database(join(dataFolder, "bridge.db"));
  newer.run("PRAGMA user_version = 99");
  newer.close();

  await expect(startBridge(dataFolder)).rejects.toThrow("has schema version 99");

  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  await lock.release();
});

test("refuses a data folder that others can open before it creates anything there", async () => {
  const dataFolder = join(createTestFolder(), "shared");
  mkdirSync(dataFolder);
  chmodSync(dataFolder, 0o755);

  await expect(startBridge(dataFolder)).rejects.toThrow(BridgeRefusedError);

  expect(readdirSync(dataFolder)).toEqual([]);
});

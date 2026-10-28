import { expect, onTestFinished, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireBridgeLock, type BridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder } from "./testFixtures";

async function acquire(path: string): Promise<BridgeLock> {
  const lock = await acquireBridgeLock(path);
  onTestFinished(() => lock.release());
  return lock;
}

test("refuses a second holder while the first holds the lock", async () => {
  const path = join(createTestFolder(), "bridge.lock");
  await acquire(path);

  const second = acquireBridgeLock(path);

  await expect(second).rejects.toThrow(BridgeRefusedError);
  await expect(second).rejects.toThrow("already running");
});

test("keeps the lock when a refused holder lets go of the file", async () => {
  const path = join(createTestFolder(), "bridge.lock");
  await acquire(path);

  await acquireBridgeLock(path).catch(() => undefined);

  await expect(acquireBridgeLock(path)).rejects.toThrow(BridgeRefusedError);
});

test("can be taken again once it's released", async () => {
  const path = join(createTestFolder(), "bridge.lock");
  const first = await acquireBridgeLock(path);
  await first.release();

  await acquire(path);
});

test("locks the exact file even when its path contains ? and #", async () => {
  const folder = join(createTestFolder(), "a?b#c");
  const path = join(folder, "bridge.lock");
  await Bun.write(join(folder, ".keep"), "");

  await acquire(path);

  expect(existsSync(path)).toBe(true);
  await expect(acquireBridgeLock(path)).rejects.toThrow(BridgeRefusedError);
});

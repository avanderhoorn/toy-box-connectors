import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "./bridge";
import { BridgeRefusedError } from "./refusal";
import { createDatabaseMadeBy, createTestFolder } from "./testFixtures";

// No Toy Box URL from the shell running the tests. A new database has no links, so the bridge
// never calls Toy Box's default address.
const env = {};

async function start(dataFolder: string) {
  const bridge = await startBridge(dataFolder, env);
  onTestFinished(() => bridge.stop());
  return bridge;
}

test("creates its data folder, lock and database on first start", async () => {
  const dataFolder = join(createTestFolder(), ".toy-box-slack");

  await start(dataFolder);

  expect(statSync(dataFolder).mode & 0o777).toBe(0o700);
  expect(readdirSync(dataFolder)).toEqual(expect.arrayContaining(["bridge.db", "bridge.lock"]));
});

test("refuses a data folder that others can open before it creates anything there", async () => {
  const dataFolder = join(createTestFolder(), "shared");
  mkdirSync(dataFolder);
  chmodSync(dataFolder, 0o755);

  await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);

  expect(readdirSync(dataFolder)).toEqual([]);
});

test("refuses tokens that others can read before it takes the lock", async () => {
  const dataFolder = createTestFolder();
  writeFileSync(join(dataFolder, "credentials.env"), "SLACK_BOT_TOKEN=xoxb-1\n", { mode: 0o644 });

  await expect(startBridge(dataFolder, env)).rejects.toThrow("must be 600");

  expect(readdirSync(dataFolder)).toEqual(["credentials.env"]);
});

test("refuses a bridge.db another version made until the owner starts over", async () => {
  const dataFolder = createTestFolder();
  await createDatabaseMadeBy(join(dataFolder, "bridge.db"), 1);

  await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);
  for (const file of ["bridge.db", "bridge.db-wal", "bridge.db-shm"]) {
    rmSync(join(dataFolder, file), { force: true });
  }

  await start(dataFolder);
});

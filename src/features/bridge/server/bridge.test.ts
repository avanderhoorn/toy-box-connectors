import { expect, onTestFinished, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { App } from "./apps";
import { startBridge } from "./bridge";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";
import { createAddedApp, createDatabaseMadeBy, createTestFolder } from "./testFixtures";

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

test("holds every app's own lock and bridge.db while it runs, and lets each lock go when it stops", async () => {
  const dataFolder = createTestFolder();
  const releases = createAddedApp(dataFolder, "releases");
  const locks = [join(dataFolder, "bridge.lock"), releases.lock];

  const bridge = await startBridge(dataFolder, env);
  for (const lock of locks) {
    await expect(acquireBridgeLock(lock)).rejects.toThrow(BridgeRefusedError);
  }
  expect(existsSync(join(dataFolder, "bridge.db"))).toBe(true);
  expect(existsSync(releases.database)).toBe(true);
  await bridge.stop();

  for (const lock of locks) await (await acquireBridgeLock(lock)).release();
});

test("refuses an added app's folder or tokens that others can open before it takes any lock", async () => {
  for (const spoil of [
    (app: App) => chmodSync(app.folder, 0o755),
    (app: App) => chmodSync(app.credentials, 0o644),
  ]) {
    const dataFolder = createTestFolder();
    const releases = createAddedApp(dataFolder, "releases", { SLACK_BOT_TOKEN: "xoxb-1" });
    spoil(releases);

    await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);

    expect(readdirSync(dataFolder)).toEqual(["apps"]);
    expect(readdirSync(releases.folder)).toEqual(["credentials.env"]);
  }
});

test("refuses while another bridge holds an added app's lock, letting go of the locks it took", async () => {
  const dataFolder = createTestFolder();
  const releases = createAddedApp(dataFolder, "releases");
  const held = await acquireBridgeLock(releases.lock);
  onTestFinished(() => held.release());

  await expect(startBridge(dataFolder, env)).rejects.toThrow(
    `Another toy-box-slack bridge is already running for ${releases.folder}. Stop it before starting a new one.`,
  );

  expect(existsSync(join(dataFolder, "bridge.db"))).toBe(false);
  expect(existsSync(releases.database)).toBe(false);
  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  await lock.release();
});

test("refuses an added app's bridge.db another version made, letting go of every app it opened", async () => {
  const dataFolder = createTestFolder();
  const releases = createAddedApp(dataFolder, "releases");
  await createDatabaseMadeBy(releases.database, 1);

  await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);
  for (const file of ["bridge.db", "bridge.db-wal", "bridge.db-shm"]) {
    rmSync(join(releases.folder, file), { force: true });
  }

  await start(dataFolder);
});

import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Every path under `folder`, to notice anything created there. */
function contents(folder: string) {
  return readdirSync(folder, { recursive: true, encoding: "utf8" }).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

test("creates its data folder, lock and database on first start", async () => {
  const dataFolder = join(createTestFolder(), ".toy-box-slack");

  await start(dataFolder);

  expect(statSync(dataFolder).mode & 0o777).toBe(0o700);
  expect(readdirSync(dataFolder)).toEqual(expect.arrayContaining(["bridge.db", "bridge.lock"]));
});

test.each<[string, (dataFolder: string, releases: App) => void]>([
  ["a data folder", (dataFolder) => chmodSync(dataFolder, 0o755)],
  [
    "the default app's tokens",
    (dataFolder) =>
      writeFileSync(join(dataFolder, "credentials.env"), "SLACK_BOT_TOKEN=xoxb-1\n", {
        mode: 0o644,
      }),
  ],
  ["an added app's folder", (_, releases) => chmodSync(releases.folder, 0o755)],
  ["an added app's tokens", (_, releases) => chmodSync(releases.credentials, 0o644)],
])(
  "refuses %s that others can open before it creates anything or takes a lock",
  async (_, spoil) => {
    const dataFolder = createTestFolder();
    const releases = createAddedApp(dataFolder, "releases", { SLACK_BOT_TOKEN: "xoxb-1" });
    spoil(dataFolder, releases);
    const before = contents(dataFolder);

    await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);

    expect(contents(dataFolder)).toEqual(before);
  },
);

test.each(["default", "releases"])(
  "refuses the %s app's bridge.db another version made, letting go of every app until the owner starts over",
  async (name) => {
    const dataFolder = createTestFolder();
    const releases = createAddedApp(dataFolder, "releases");
    const folder = name === "default" ? dataFolder : releases.folder;
    await createDatabaseMadeBy(join(folder, "bridge.db"), 1);

    await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);
    for (const file of ["bridge.db", "bridge.db-wal", "bridge.db-shm"]) {
      rmSync(join(folder, file), { force: true });
    }

    await start(dataFolder);
  },
);

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

import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startBridge } from "./bridge";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";
import { createAddedApp, createTestFolder } from "./testFixtures";

// No Toy Box URL from the shell running the tests. A new database has no links, so the bridge
// never calls Toy Box's default address.
const env = {};

/** Every path under `folder`, to notice anything created there. */
function contents(folder: string) {
  return readdirSync(folder, { recursive: true, encoding: "utf8" }).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

test("refuses an added app's tokens that others can open before it creates anything or takes a lock", async () => {
  const dataFolder = createTestFolder();
  const releases = createAddedApp(dataFolder, "releases", { SLACK_BOT_TOKEN: "xoxb-1" });
  chmodSync(releases.credentials, 0o644);
  const before = contents(dataFolder);

  await expect(startBridge(dataFolder, env)).rejects.toThrow(BridgeRefusedError);

  expect(contents(dataFolder)).toEqual(before);
});

test("refuses while another bridge holds an added app's lock, leaving its images and letting go of the locks it took", async () => {
  const dataFolder = createTestFolder();
  const releases = createAddedApp(dataFolder, "releases");
  const held = await acquireBridgeLock(releases.lock);
  onTestFinished(() => held.release());
  const image = join(dataFolder, "viewing", `f1-${crypto.randomUUID()}.png`);
  mkdirSync(dirname(image));
  writeFileSync(image, "");

  await expect(startBridge(dataFolder, env)).rejects.toThrow(
    `Another toy-box-slack bridge is already running for ${releases.folder}. Stop it before starting a new one.`,
  );

  expect(existsSync(join(dataFolder, "bridge.db"))).toBe(false);
  expect(existsSync(releases.database)).toBe(false);
  expect(existsSync(image)).toBe(true);
  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  await lock.release();
});

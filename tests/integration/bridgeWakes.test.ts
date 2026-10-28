import { expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge } from "./bridgeProcess";
import { waitFor } from "./waitFor";

const REQUESTS_ROUTINE = {
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox` and answer what's waiting.",
};
const DAY = 24 * 60 * 60_000;

/**
 * A data folder whose link follows a fake Toy Box channel and holds one open request, and the
 * environment that points a bridge at them with a short debounce. `prepare` changes the database
 * before the bridge opens it.
 */
async function linkFakeChannel(prepare?: (database: BridgeDatabase) => Promise<unknown>) {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  await withDatabase(dataFolder, async (database) => {
    await createStoredLink(database, "link", {
      toybox_channel_id: channelId,
      requests_routine_id: routine.id,
    });
    const at = Date.now();
    await createStoredRequest(database, { createdAt: at, changedAt: at, expiresAt: at + DAY });
    await prepare?.(database);
  });
  const env = {
    TOY_BOX_URL: toyBox.url,
    TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify({ debounce: 50, debounceLimit: 200 }),
  };
  return { toyBox, channelId, routine, home, dataFolder, env };
}

/** Opens the data folder's database for `use` while no bridge holds it. */
async function withDatabase<T>(dataFolder: string, use: (database: BridgeDatabase) => Promise<T>) {
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    return await use(database);
  } finally {
    await database.close();
  }
}

test("a running bridge follows its linked channel, wakes the lead once and stops on SIGTERM", async () => {
  const { toyBox, channelId, routine, home, dataFolder, env } = await linkFakeChannel();
  const bridge = spawnBridge(home, env);
  await bridge.running();

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  bridge.child.kill("SIGTERM");

  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `toy-box-slack is running for ${dataFolder}\ntoy-box-slack is stopping after SIGTERM\n`,
  });
  expect(toyBox.streamRequests).toEqual([{ channelId, after: null, answer: "snapshot" }]);
  expect(toyBox.runs.map(({ routineId, by }) => ({ routineId, by }))).toEqual([
    { routineId: routine.id, by: "api" },
  ]);
  const wakes = await withDatabase(dataFolder, (database) =>
    database.read((sql) => sql`SELECT link_id, kind, outcome FROM wakes`),
  );
  expect(wakes).toEqual([{ link_id: "link", kind: "requests", outcome: "ran" }]);
}, 15_000);

test("a storage error stops the bridge with exit code 1 so launchd restarts it", async () => {
  const { toyBox, home, dataFolder, env } = await linkFakeChannel((database) =>
    database.write(
      (transaction) => transaction`
        CREATE TRIGGER full_disk BEFORE INSERT ON wakes
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `,
    ),
  );

  const { code, stderr } = await spawnBridge(home, env).exit();

  expect(code).toBe(1);
  expect(stderr).toStartWith(`toy-box-slack is running for ${dataFolder}\nStopped waking leads:`);
  expect(stderr).toContain("database or disk is full");
  expect(stderr).toEndWith("toy-box-slack is stopping after an error\n");
  expect(toyBox.runs).toHaveLength(1);
}, 15_000);

test("a storage error while following Toy Box stops the bridge with exit code 1 too", async () => {
  const { toyBox, channelId, home, env } = await linkFakeChannel((database) =>
    database.write(
      (transaction) => transaction`
        CREATE TRIGGER full_disk BEFORE INSERT ON toybox_streams
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `,
    ),
  );

  const { code, stderr } = await spawnBridge(home, env).exit();

  expect(code).toBe(1);
  expect(stderr).toContain(`Stopped following Toy Box channel ${channelId}:`);
  expect(stderr).toContain("database or disk is full");
  expect(stderr).toEndWith("toy-box-slack is stopping after an error\n");
  expect(toyBox.runs).toEqual([]);
}, 15_000);

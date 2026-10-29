// The bridge as launchd runs it, waking the lead of its linked channel in a fake Toy Box.

import { expect, test } from "bun:test";
import { started, withDatabase } from "./bridgeProcess";
import { startLinkedBridge, storeNewRequest } from "./linkedBridge";
import { waitFor } from "./waitFor";

// The lead is woken 50 ms after a request arrives, rather than after the real debounce.
const PROMPTLY = {
  TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify({ debounce: 50, debounceLimit: 200 }),
};

test("a running bridge wakes the lead once for a new request, and stops on SIGTERM", async () => {
  const { toyBox, channelId, routine, bridge, home, dataFolder } = await startLinkedBridge({
    env: PROMPTLY,
    prepare: storeNewRequest,
  });

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  bridge.child.kill("SIGTERM");

  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `${started(home)}toy-box-slack is stopping after SIGTERM\n`,
  });
  expect(toyBox.runs).toEqual([{ channelId, routineId: routine.id, at: expect.any(Number) }]);
  const wakes = await withDatabase(dataFolder, (database) =>
    database.read((sql) => sql`SELECT link_id, outcome FROM wakes`),
  );
  expect(wakes).toEqual([{ link_id: "link", outcome: "ran" }]);
}, 15_000);

test("a storage error stops the bridge with exit code 1 so launchd restarts it", async () => {
  const { toyBox, bridge, home } = await startLinkedBridge({
    env: PROMPTLY,
    prepare: async (database) => {
      await storeNewRequest(database);
      await database.write(
        (transaction) => transaction`
          CREATE TRIGGER full_disk BEFORE INSERT ON wakes
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
        `,
      );
    },
  });

  const { code, stderr } = await bridge.exit();

  expect(code).toBe(1);
  expect(stderr).toStartWith(`${started(home)}Stopped waking leads:`);
  expect(stderr).toContain("database or disk is full");
  expect(stderr).toEndWith("toy-box-slack is stopping after an error\n");
  expect(toyBox.runs).toHaveLength(1);
}, 15_000);

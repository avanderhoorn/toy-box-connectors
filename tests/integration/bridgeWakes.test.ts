// The bridge as `serve` runs it without a terminal, waking the lead of its linked channel in a fake
// Toy Box, and showing whoever asked in a fake Slack that it did.

import { expect, test } from "bun:test";
import { started, withDatabase } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, said, timestamps } from "./connectedBridge";
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

test("whoever asked sees 👀 once Toy Box runs the lead's wake, before the lead reads it", async () => {
  const { slack, toyBox, inbox, post, stop, saying } = await connectedBridge();
  const [askedTs] = timestamps(1);
  const reactions = () => slack.calls.filter(({ method }) => method === "reactions.add");

  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  await waitFor(() =>
    expect(slack.getMessages("C-link")).toMatchObject([
      { ts: askedTs, reactions: [{ name: "eyes", count: 1, users: [BOT] }] },
    ]),
  );
  expect(await inbox()).toMatchObject({ requests: [{ id: 1, state: "open" }] });
  // Inbox marks what it shows too, for a lead that reads without a wake, and Slack's refusal of a
  // second 👀 goes unremarked.
  await waitFor(() => expect(reactions()).toHaveLength(2));
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
}, 15_000);

test("a storage error stops the bridge with exit code 1 instead of retrying", async () => {
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

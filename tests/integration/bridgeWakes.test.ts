// The bridge as `serve` runs it without a terminal, waking the lead of its linked channel in a fake
// Toy Box, and showing whoever asked in a fake Slack that it did.

import { expect, test } from "bun:test";
import { started } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, said, timestamps } from "./connectedBridge";
import { startLinkedBridge, storeNewRequest } from "./linkedBridge";
import { waitFor } from "./waitFor";

// The lead is woken 50 ms after a request arrives, rather than after the real debounce.
const PROMPTLY = {
  TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify({ debounce: 50, debounceLimit: 200 }),
};

test("whoever asked sees 👀 once Toy Box runs the lead's wake, and 🏃 once the lead reads it", async () => {
  const { slack, toyBox, inbox, post, stop, saying } = await connectedBridge();
  const [askedTs] = timestamps(1);

  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));

  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["eyes"]));
  expect(await inbox()).toMatchObject({ requests: [{ id: 1, state: "open" }] });
  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["runner"]));
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
}, 15_000);

test("whoever asked sees 👀 again when they edit the mention out of a request the lead read", async () => {
  const { slack, toyBox, inbox, post, edit, stop, saying } = await connectedBridge();
  const [askedTs, editedTs] = timestamps(2);
  const asked = said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`);
  await post(asked);
  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  expect(await inbox()).toMatchObject({ requests: [{ id: 1, state: "open" }] });
  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["runner"]));

  await edit(asked, "never mind the deploy", editedTs);

  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["eyes"]));
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
}, 15_000);

test("whoever asked sees 👀 again when the lead dismisses a request it read", async () => {
  const { slack, toyBox, inbox, dismiss, post, stop, saying } = await connectedBridge();
  const [askedTs] = timestamps(1);
  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));
  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["eyes"]));
  expect(await inbox()).toMatchObject({ requests: [{ id: 1, state: "open" }] });
  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["runner"]));

  expect(await dismiss(1, "Answered in standup")).toMatchObject({ exitCode: 0 });

  await waitFor(() => expect(slack.reactionNames("C-link", askedTs)).toEqual(["eyes"]));
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

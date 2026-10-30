// The bridge as `serve` runs it without a terminal, off Slack until it has both tokens, and then
// with both tokens for a fake Slack.

import { expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import { missingTokensProblem } from "@slackapi/model/identity";
import { startSlackForBridge, started, withDatabase } from "./bridgeProcess";
import { startLinkedBridge, storeNewRequest } from "./linkedBridge";
import { waitFor } from "./waitFor";

function post(ts: string) {
  return { type: "message", channel: "C-link", user: "U-carol", team: "TFAKE", text: "Hi", ts };
}

type Bridge = Awaited<ReturnType<typeof startLinkedBridge>>;

/** Waits until status shows the owner a bridge connected to Slack. */
function connected({ status }: Bridge) {
  return waitFor(
    async () =>
      expect(await status(null)).toMatchObject({
        exitCode: 0,
        json: { slack: { connection: "connected", problem: null } },
      }),
    5_000,
  );
}

test("a bridge with both tokens connects to Slack, and acks an event once it's stored", async () => {
  const { slack, env } = startSlackForBridge();
  const linked = await startLinkedBridge({ env });
  const { bridge, home, dataFolder } = linked;
  await connected(linked);

  const sent = slack.sendEvent(post("1700000200.000100"));
  expect(await slack.waitForAck(sent.envelopeId, 5_000)).not.toBeNull();

  bridge.child.kill("SIGTERM");
  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `${started(home)}Connected to Slack.\ntoy-box-slack is stopping after SIGTERM\n`,
  });
  const messages = await withDatabase(dataFolder, (database) =>
    database.read((sql) => sql`SELECT ts FROM messages`),
  );
  expect(messages).toEqual([{ ts: "1700000200.000100" }]);
}, 15_000);

test("a bridge missing a token stays off Slack, and status says how the owner gives it", async () => {
  const linked = await startLinkedBridge({ env: { SLACK_BOT_TOKEN: "xoxb-1" } });

  expect(await linked.status(null)).toMatchObject({
    exitCode: 0,
    json: {
      slack: {
        connection: "unconfigured",
        problem: missingTokensProblem(["SLACK_APP_TOKEN"], DEFAULT_APP),
      },
    },
  });
}, 15_000);

test("a bridge that can't store an event exits 1 without acking it", async () => {
  const { slack, env } = startSlackForBridge();
  const linked = await startLinkedBridge({
    env,
    prepare: (database) =>
      database.write(
        (transaction) => transaction`
          CREATE TRIGGER disk_full BEFORE INSERT ON messages
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
        `,
      ),
  });
  await connected(linked);

  const sent = slack.sendEvent(post("1700000200.000100"));

  const { code, stderr } = await linked.bridge.exit();
  expect(code).toBe(1);
  expect(stderr).toContain("Stopped receiving from Slack:");
  expect(stderr).toContain("database or disk is full");
  expect(stderr).toEndWith("toy-box-slack is stopping after an error\n");
  expect(await slack.waitForAck(sent.envelopeId, 0)).toBeNull();
}, 15_000);

test("inbox links each request to its message in the workspace Slack names", async () => {
  const { env } = startSlackForBridge();
  const linked = await startLinkedBridge({ env, prepare: storeNewRequest });
  await connected(linked);

  const { requests } = await linked.inbox();

  expect(requests.map(({ permalink }) => permalink)).toEqual([
    "https://fake-workspace.slack.com/archives/C-link/p1700000100000100",
  ]);
}, 15_000);

test("status names the link's channels as Slack and Toy Box call them", async () => {
  const { env } = startSlackForBridge();
  const linked = await startLinkedBridge({ env });
  await connected(linked);

  const { text } = await linked.status(null);

  expect(text).toContain('\n\n## #fake-channel and Toy Box channel "Linked"\n');
}, 15_000);

// The bridge as launchd runs it, with or without both tokens for a fake Slack.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { inboxResultSchema } from "@commands/model/inbox";
import { commandPath, commandResultSchema } from "@commands/model/protocol";
import { createStoredRequest } from "@requests/server/testFixtures";
import { startSlackForBridge } from "./bridgeProcess";
import { startLinkedBridge } from "./linkedBridge";
import { waitFor } from "./waitFor";

const DAY = 24 * 60 * 60_000;
// The lead is woken for a new request at once, and Slack is asked again soon after a failure.
const TIMINGS = JSON.stringify({ debounce: 50, debounceLimit: 200, retry: 10, retryLimit: 100 });

function post(ts: string) {
  return { type: "message", channel: "C-link", user: "U-carol", team: "TFAKE", text: "Hi", ts };
}

/** Opens a request on the link at 1700000100.000100 that expires in a day. */
function openRequest(database: BridgeDatabase) {
  const at = Date.now();
  return createStoredRequest(database, { createdAt: at, changedAt: at, expiresAt: at + DAY });
}

type Status = (sessionId: null) => Promise<unknown>;

/** Waits until the operator's status shows `slack`, and the link's wake when it's given. */
async function statusShows(status: Status, slack: object, wake?: object) {
  await waitFor(
    async () =>
      expect(await status(null)).toMatchObject({
        status: 200,
        answer: { result: { slack, ...(wake && { links: [{ wake }] }) } },
      }),
    5_000,
  );
}

const connected = { connection: "connected", problem: null };

test("a bridge with both tokens connects to Slack, and acks an event once it's stored", async () => {
  const { slack, env } = startSlackForBridge();
  const { bridge, dataFolder, status } = await startLinkedBridge({ env });
  await statusShows(status, connected);

  const sent = slack.sendEvent(post("1700000200.000100"));
  expect(await slack.waitForAck(sent.envelopeId, 5_000)).not.toBeNull();

  bridge.child.kill("SIGTERM");
  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `toy-box-slack is running for ${dataFolder}\ntoy-box-slack is stopping after SIGTERM\n`,
  });
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    expect(await database.read((sql) => sql`SELECT ts FROM messages`)).toEqual([
      { ts: "1700000200.000100" },
    ]);
  } finally {
    await database.close();
  }
}, 15_000);

test("a bridge that can't store an event exits 1 without acking it", async () => {
  const { slack, env } = startSlackForBridge();
  const { bridge, status } = await startLinkedBridge({
    env,
    prepare: (database) =>
      database.write(
        (transaction) => transaction`
          CREATE TRIGGER disk_full BEFORE INSERT ON receipts
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
        `,
      ),
  });
  await statusShows(status, connected);

  const sent = slack.sendEvent(post("1700000200.000100"));

  const { code, stderr } = await bridge.exit();
  expect(code).toBe(1);
  expect(stderr).toContain("Stopped receiving from Slack:");
  expect(stderr).toContain("database or disk is full");
  expect(stderr).toEndWith("toy-box-slack is stopping after an error\n");
  expect(await slack.waitForAck(sent.envelopeId, 0)).toBeNull();
}, 15_000);

test("a bridge without both tokens leaves its lead's wake waiting until it can use Slack", async () => {
  const { toyBox, status } = await startLinkedBridge({
    env: { TOY_BOX_SLACK_WAKE_TIMINGS: TIMINGS },
    prepare: openRequest,
  });

  await statusShows(status, { connection: "unconfigured" }, { kind: "wait", until: "slack" });
  expect(toyBox.runs).toEqual([]);
});

test("a bridge wakes its lead once Slack says hello, and not while it connects", async () => {
  const { slack, env } = startSlackForBridge();
  // Slack holds the connection back for a second, so the wake is decided while it connects.
  slack.failNext("apps.connections.open", { retryAfter: 1 });
  const { toyBox, status } = await startLinkedBridge({
    env: { ...env, TOY_BOX_SLACK_WAKE_TIMINGS: TIMINGS },
    prepare: openRequest,
  });

  await statusShows(status, { connection: "connecting" }, { kind: "wait", until: "slack" });
  expect(toyBox.runs).toEqual([]);
  await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
}, 15_000);

test("inbox links each request to its message in the workspace Slack names", async () => {
  const { env } = startSlackForBridge();
  const { channelId, socket, port, status } = await startLinkedBridge({
    env,
    prepare: openRequest,
  });
  await statusShows(status, connected);

  const response = await fetch(`http://localhost${commandPath("inbox")}`, {
    unix: socket,
    method: "POST",
    body: JSON.stringify({
      caller: { sessionId: channelId, toyBoxPort: port, channelId: null },
      input: {},
    }),
  });

  const { result } = commandResultSchema(inboxResultSchema).parse(await response.json());
  expect(result.requests.map(({ permalink }) => permalink)).toEqual([
    "https://fake-workspace.slack.com/archives/C-link/p1700000100000100",
  ]);
}, 15_000);

// A Slack channel linked to a test channel through the real bridge.
//
// The bridge runs as its owner's would, as `toy-box-slack serve` under the isolated Toy Box's HOME,
// so the lead's commands reach it, and it wakes the lead through that Toy Box. Slack is a fake with
// the guarantee suites' channel and people: the link watches C-link and allows Alice, and Mallory is
// in the channel too. Until the owner commands land, the harness writes the link into the bridge's
// database before the bridge starts.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { prepareDataFolder, resolveDataFolder } from "@bridge/server/dataFolder";
import { createStoredLink } from "@links/server/testFixtures";
import type { WakeTimings } from "@wakes/model";
import { startFakeSlack, type FakeSlack, type FakeSlackMessage } from "../fakes/slack";
import { withDatabase } from "../integration/bridgeProcess";
import { ALICE, BOT, MALLORY, posted } from "../integration/connectedBridge";
import { REQUESTS_ROUTINE as WEEKDAY_REQUESTS_ROUTINE } from "../integration/linkedBridge";
import { CLI, waitUntil, type IsolatedToyBox } from "./isolatedToyBox";
import type { TestChannel } from "./testChannel";

/** The routine a linked channel's lead adds, on a schedule no run reaches, so only the bridge runs it. */
export const REQUESTS_ROUTINE = { ...WEEKDAY_REQUESTS_ROUTINE, schedule: "0 4 1 1 *" };

/** Wakes the lead a second after a request changes, so no scenario waits out the real debounce. */
const PROMPTLY: Partial<WakeTimings> = { debounce: 1_000, debounceLimit: 2_000 };

// Connecting waits on the bridge starting and Slack confirming its tokens, and an ack on the bridge
// storing the event, all on this Mac.
const SLACK_TIMEOUT = 10_000;

// The bridge stops at once on SIGTERM, since nothing it's waiting on is worth keeping it for.
const STOP_TIMEOUT = 5_000;

export type SlackLink = {
  slack: FakeSlack;
  /** Posts `message` in C-link, and resolves once the bridge acked its event. */
  post(message: FakeSlackMessage): Promise<void>;
  /** The rows `query` reads from the bridge's database as it stands. */
  query<Row>(query: string, ...bindings: SQLQueryBindings[]): Row[];
  /** Stops the bridge, then Slack, which fails on any call it doesn't know. */
  stop(): Promise<void>;
};

/**
 * Links `channel` to C-link once its lead has added the requests routine, and resolves once the
 * bridge serving the link has connected to Slack.
 */
export async function linkSlack(toyBox: IsolatedToyBox, channel: TestChannel): Promise<SlackLink> {
  const slack = startFakeSlack({
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: BOT },
  });
  slack.addChannel({
    id: "C-link",
    name: "release-eng",
    is_private: true,
    members: [BOT, ALICE, MALLORY],
  });
  const dataFolder = resolveDataFolder({}, toyBox.home);
  let bridge: Subprocess | undefined;
  let stopped: Promise<void> | undefined;

  function serving() {
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) return;
    throw new Error(`The bridge exited with ${bridge?.signalCode ?? bridge?.exitCode}.`);
  }

  async function stopBridge() {
    if (!bridge) return;
    bridge.kill("SIGTERM");
    const code = await Promise.race([bridge.exited, Bun.sleep(STOP_TIMEOUT)]);
    if (code === undefined) {
      bridge.kill("SIGKILL");
      await bridge.exited;
      throw new Error(`The bridge didn't stop within ${STOP_TIMEOUT / 1000} s of SIGTERM.`);
    }
    if (code !== 0) throw new Error(`The bridge exited with ${code}.`);
  }

  const link: SlackLink = {
    slack,

    async post(message) {
      serving();
      slack.setMessage("C-link", message);
      const { envelopeId } = slack.sendEvent(posted(message));
      if (!(await slack.waitForAck(envelopeId, SLACK_TIMEOUT))) {
        throw new Error(`The bridge didn't ack ${message.ts} within ${SLACK_TIMEOUT / 1000} s.`);
      }
    },

    query<Row>(query: string, ...bindings: SQLQueryBindings[]) {
      const database = new Database(join(dataFolder, "bridge.db"), { readonly: true });
      try {
        return database.query<Row, SQLQueryBindings[]>(query).all(...bindings);
      } finally {
        database.close();
      }
    },

    stop() {
      stopped ??= (async () => {
        try {
          await stopBridge();
        } finally {
          await slack.stop();
        }
      })().catch((error: unknown) => {
        throw toyBox.failure(error);
      });
      return stopped;
    },
  };

  try {
    await waitUntil(
      "the lead to add its requests routine",
      () => channel.routine(REQUESTS_ROUTINE.title),
      10_000,
    );
    await storeLink(dataFolder, channel.id);
    bridge = serve(toyBox, slack);
    await waitUntil(
      "the bridge to connect to Slack",
      () => {
        serving();
        return slack.activeConnections === 1 || undefined;
      },
      SLACK_TIMEOUT,
    );
    return link;
  } catch (error) {
    const failure = toyBox.failure(error);
    await link.stop().catch((stopFailure: unknown) => console.error(stopFailure));
    throw failure;
  }
}

/** Writes the link the owner's commands would, allowing Alice, before any bridge opens it. */
async function storeLink(dataFolder: string, channelId: string) {
  prepareDataFolder(dataFolder);
  await withDatabase(dataFolder, async (database) => {
    await createStoredLink(database, "link", { toybox_channel_id: channelId });
    await database.write(
      (transaction) => transaction`
        INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', ${ALICE}, 0)
      `,
    );
  });
}

/** Runs `toy-box-slack serve` for the isolated Toy Box against `slack`, logging into the run's folder. */
function serve(toyBox: IsolatedToyBox, slack: FakeSlack): Subprocess {
  const log = openSync(join(toyBox.folder, "bridge.log"), "a");
  const bridge = Bun.spawn([process.execPath, "--no-env-file", CLI, "serve"], {
    env: {
      PATH: process.env.PATH,
      HOME: toyBox.home,
      TOY_BOX_URL: toyBox.origin.origin,
      SLACK_API_URL: slack.url,
      SLACK_BOT_TOKEN: slack.botToken,
      SLACK_APP_TOKEN: slack.appToken,
      TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify(PROMPTLY),
    },
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  closeSync(log);
  return bridge;
}

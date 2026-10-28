// A Slack channel linked to a test channel through the real bridge.
//
// The bridge runs as its owner's would, as `toy-box-slack serve` under the isolated Toy Box's HOME,
// so the lead's commands reach it, and it wakes the lead through that Toy Box. Slack is a fake with
// the guarantee suites' people: the link watches C0LINK, a private channel the bot, Alice and
// Mallory are in, and allows Alice. The owner sets it up at a terminal in the order the skill gives
// them: they set a passphrase, start the bridge, link C0LINK and allow Alice, typing the passphrase
// for each.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { resolveDataFolder } from "@bridge/server/dataFolder";
import { BUNDLED_SKILL } from "@commands/client/skill";
import type { WakeTimings } from "@wakes/model";
import { startFakeSlack, type FakeSlack, type FakeSlackMessage } from "../fakes/slack";
import { ALICE, BOT, MALLORY, posted } from "../integration/connectedBridge";
import { CLI, runCli, waitUntil, type IsolatedToyBox } from "./isolatedToyBox";
import type { TestChannel } from "./testChannel";

/** A routine's bold title, its schedules, and its prompt on one line in a text block. */
const SKILL_ROUTINE = /^\*\*(.+)\*\*, .+\n\n```text\n(.+)\n```$/gm;

/** The routine a linked channel's lead adds, which the bridge runs to wake it. */
export const REQUESTS_ROUTINE = skillRoutine("Slack requests");

/** Wakes the lead a second after a request changes, so no scenario waits out the real debounce. */
const PROMPTLY: Partial<WakeTimings> = { debounce: 1_000, debounceLimit: 2_000 };

// Connecting waits on the bridge starting and Slack confirming its tokens, and an ack on the bridge
// storing the event, all on this Mac.
const SLACK_TIMEOUT = 10_000;

// The bridge stops at once on SIGTERM, since nothing it's waiting on is worth keeping it for.
const STOP_TIMEOUT = 5_000;

const PASSPHRASE = "correct horse battery staple";

export type SlackLink = {
  slack: FakeSlack;
  /** Posts `message` in C0LINK, and resolves once the bridge acked its event. */
  post(message: FakeSlackMessage): Promise<void>;
  /** The rows `query` reads from the bridge's database as it stands. */
  query<Row>(query: string, ...bindings: SQLQueryBindings[]): Row[];
  /** Stops the bridge as its owner would, calls `whileDown`, and serves the link again. */
  restart(whileDown: () => void): Promise<void>;
  /** Stops the bridge, then Slack, which fails on any call it doesn't know. */
  stop(): Promise<void>;
};

/**
 * Links `channel` to C0LINK once its lead has added the requests routine, and resolves once the
 * bridge serving the link has connected to Slack and the owner has allowed Alice.
 */
export async function linkSlack(toyBox: IsolatedToyBox, channel: TestChannel): Promise<SlackLink> {
  const slack = startFakeSlack({
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: BOT },
  });
  slack.addChannel({
    id: "C0LINK",
    name: "release-eng",
    is_private: true,
    members: [BOT, ALICE, MALLORY],
  });
  slack.setUser({
    id: ALICE,
    team_id: "T-home",
    real_name: "Alice",
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
  });
  const dataFolder = resolveDataFolder({}, toyBox.home);
  let bridge: Subprocess | undefined;

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

  async function startBridge() {
    const opened = slack.connections.length;
    bridge = serve(toyBox, slack);
    await waitUntil(
      "the bridge to connect to Slack",
      () => {
        serving();
        return slack.connections.length > opened || undefined;
      },
      SLACK_TIMEOUT,
    );
  }

  const link: SlackLink = {
    slack,

    async post(message) {
      serving();
      slack.setMessage("C0LINK", message);
      const { envelopeId } = slack.sendEvent(posted(message, "C0LINK"));
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

    async restart(whileDown) {
      await stopBridge();
      whileDown();
      await startBridge();
    },

    async stop() {
      await stopBridge()
        .finally(() => slack.stop())
        .catch((error: unknown) => {
          throw toyBox.failure(error);
        });
    },
  };

  try {
    await waitUntil(
      "the lead to add its requests routine",
      () => channel.routine(REQUESTS_ROUTINE.title),
      10_000,
    );
    await runAsOwner(toyBox, "passphrase");
    await startBridge();
    await runAsOwner(toyBox, "link", "--slack-channel", "C0LINK", "--channel", channel.id);
    await runAsOwner(toyBox, "allow", ALICE, "--channel", channel.id);
    return link;
  } catch (error) {
    const failure = toyBox.failure(error);
    await link.stop().catch((stopFailure: unknown) => console.error(stopFailure));
    throw failure;
  }
}

/**
 * The routine the skill has a lead add as `title`, with the prompt leads copy from it, on a schedule
 * no run reaches, so only the bridge or a scenario runs it.
 */
export function skillRoutine(title: string) {
  for (const [, heading, prompt] of readFileSync(BUNDLED_SKILL, "utf8").matchAll(SKILL_ROUTINE)) {
    if (heading === title && prompt) return { title, schedule: "0 4 1 1 *", prompt };
  }
  throw new Error(`The skill gives no routine titled "${title}".`);
}

/** Runs `toy-box-slack <args>` as the owner at a terminal, typing their passphrase at each prompt. */
function runAsOwner(toyBox: IsolatedToyBox, ...args: string[]) {
  return runCli(toyBox.home, args, `${PASSPHRASE}\n`.repeat(2));
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

// A running bridge connected to a fake Slack, and the events Slack sends it about its channel.

import { expect } from "bun:test";
import { tsAt, type SlackTs } from "@slackapi/model/ts";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import type { FakeEventOptions, FakeSlackMessage } from "../fakes/slack";
import { startSlackForBridge } from "./bridgeProcess";
import { startLinkedBridge, type LinkColumns } from "./linkedBridge";
import { waitFor } from "./waitFor";

// Slack's markup names a user by an ID of capitals and digits, so a mention can name them.
export const BOT = "U0BOT";
/** A person the link allows. */
export const ALICE = "U0ALICE";
/** A person in the channel whom the link doesn't allow. */
export const MALLORY = "U0MALLORY";

/**
 * A bridge connected to a fake Slack whose workspace and app are its installation's, once Slack
 * said hello. Its link watches C-link, a private channel Alice, Mallory and the bot are in, and
 * allows Alice, and `link` changes its settings. The lead wakes 50 ms after a request changes.
 */
export async function connectedBridge({ link }: { link?: LinkColumns } = {}) {
  const { slack, env } = startSlackForBridge({
    teamId: "T-home",
    appId: "A-app",
    botId: "B-bot",
    botUserId: BOT,
  });
  slack.addChannel({
    id: "C-link",
    name: "release-eng",
    is_private: true,
    members: [BOT, ALICE, MALLORY],
  });
  const linked = await startLinkedBridge({
    env: {
      ...env,
      TOY_BOX_SLACK_WAKE_TIMINGS: JSON.stringify({ debounce: 50, debounceLimit: 200 }),
    },
    link,
    allowed: [ALICE],
    prepare: (database) => createStoredInstallation(database, { bot_user_id: BOT }),
  });
  // Slack says hello as a connection opens, so what it sends next reaches the bridge after it.
  await waitFor(() => expect(slack.activeConnections).toBe(1), 5_000);
  const { bridge, dataFolder } = linked;

  /** Sends `event` the way Slack does, and waits for the bridge to ack it, once it's stored. */
  const deliver = async (event: Record<string, unknown>, options?: FakeEventOptions) => {
    const { envelopeId } = slack.sendEvent(event, options);
    expect(await slack.waitForAck(envelopeId, 5_000)).not.toBeNull();
  };

  return {
    ...linked,
    slack,
    deliver,
    /** Posts `message` in C-link, and sends the bridge its event. */
    post: (message: FakeSlackMessage, options?: FakeEventOptions) => {
      slack.setMessage("C-link", message);
      return deliver(posted(message), options);
    },
    /** Edits `message` to say `text` at `editedTs`, and sends the bridge its event. */
    edit: (message: FakeSlackMessage, text: string, editedTs: SlackTs) => {
      const edited = { ...message, text, edited: { user: message.user, ts: editedTs } };
      slack.setMessage("C-link", edited);
      return deliver({
        type: "message",
        subtype: "message_changed",
        hidden: true,
        channel: "C-link",
        message: edited,
        previous_message: message,
        event_ts: editedTs,
        ts: editedTs,
      });
    },
    /** Stops the bridge, and resolves to how it exited. */
    stop: () => {
      bridge.child.kill("SIGTERM");
      return bridge.exit();
    },
    /** What the bridge writes to stderr from starting to stopping when it says only `lines`. */
    saying: (...lines: string[]) =>
      [
        `toy-box-slack is running for ${dataFolder}`,
        ...lines,
        "toy-box-slack is stopping after SIGTERM\n",
      ].join("\n"),
  };
}

/** `count` timestamps a second apart, starting a minute ago, in the order Slack gives them. */
export function timestamps(count: number): SlackTs[] {
  const first = Date.now() - 60_000;
  return Array.from({ length: count }, (_, index) => tsAt(first + index * 1_000));
}

/** `user`'s message at `ts` in C-link, as history holds it. `changes` replace its fields. */
export function said(
  user: string,
  ts: SlackTs,
  text: string,
  changes: Partial<FakeSlackMessage> = {},
): FakeSlackMessage {
  return { type: "message", user, team: "T-home", text, ts, ...changes };
}

/** The event Slack sends when `message` is posted in C-link. */
export function posted(message: FakeSlackMessage) {
  return { ...message, channel: "C-link", event_ts: message.ts, channel_type: "group" };
}

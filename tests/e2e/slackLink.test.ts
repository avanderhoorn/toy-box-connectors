// A Toy Box channel linked to Slack, from a Slack message to the lead acting on it.

import { afterAll, beforeAll, expect } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FakeSlack } from "../fakes/slack";
import { ALICE, BOT, MALLORY, said, timestamps } from "../integration/connectedBridge";
import { waitFor } from "../integration/waitFor";
import { linkSlack, REQUESTS_ROUTINE, type SlackLink } from "./slackLink";
import { describeEndToEnd } from "./suite";
import { CREATE_CHANNEL_TIMEOUT, createTestChannel, type TestChannel } from "./testChannel";
import { readCatalog } from "./toyBoxApi";

/** The lead's release notes routine, on a schedule no run reaches, so only a scenario runs it. */
const RELEASE_NOTES_ROUTINE = {
  title: "Release notes",
  schedule: REQUESTS_ROUTINE.schedule,
  prompt:
    "Publish release notes in Slack for tonight's release: pipe a few lines on dark mode and faster search to `toy-box-slack publish --series release-notes`, which posts them once for this run.",
};
const PURPOSE = `Answer the release team's questions from Slack, and publish release notes there. Tonight's release ships dark mode and faster search. In your kickoff turn, add ${adding(REQUESTS_ROUTINE)} Then add ${adding(RELEASE_NOTES_ROUTINE)} Run toy-box-slack only when a routine asks you to.`;

describeEndToEnd("a channel linked to Slack", (suite) => {
  let channel: TestChannel;
  let link: SlackLink;
  beforeAll(async () => {
    channel = await createTestChannel(suite.toyBox, { name: "Release", purpose: PURPOSE });
    link = await linkSlack(suite.toyBox, channel);
  }, CREATE_CHANNEL_TIMEOUT + 30_000);
  afterAll(() => link?.stop());

  suite.scenario(
    "an allowed person's mention wakes the lead, which answers once in their thread, and a stranger's gets nothing",
    async () => {
      const [strangerTs, askedTs] = timestamps(2);
      const ask = `<@${BOT}> what's going out in tonight's release?`;
      const since = Date.now();

      await channel.turn(async () => {
        await link.post(said(MALLORY, strangerTs, ask));
        await link.post(said(ALICE, askedTs, ask));
      });

      // Only the lead's own session can answer for the link, and only after inbox showed it. The
      // bridge posts the answer once the lead queues it, so the lead's turn can end first.
      await waitFor(() =>
        expect(
          link.query(
            "SELECT requester_user_id, state FROM requests WHERE root_ts IN (?, ?)",
            strangerTs,
            askedTs,
          ),
        ).toEqual([{ requester_user_id: ALICE, state: "answered" }]),
      );
      expect(
        link.query(
          "SELECT kind, channel_id, thread_ts, state FROM outbox WHERE created_at >= ?",
          since,
        ),
      ).toEqual([{ kind: "reply", channel_id: "C-link", thread_ts: askedTs, state: "sent" }]);
      expect(link.query("SELECT outcome FROM wakes WHERE at >= ?", since)).toEqual([
        { outcome: "ran" },
      ]);
      expect(seenInSlack(link.slack, askedTs)).toEqual({
        reactions: [{ name: "eyes", count: 1, users: [BOT] }],
        replies: 1,
      });
      expect(seenInSlack(link.slack, strangerTs)).toEqual({ reactions: undefined, replies: 0 });
    },
    { turns: 1 },
  );

  suite.scenario(
    "release notes post once in the channel when their routine runs twice",
    async () => {
      // Both tries share a scheduled slot, so a rerun checks every publication, not only its own.
      await channel.run(RELEASE_NOTES_ROUTINE.title);
      await waitFor(() =>
        expect(publications(link)).toMatchObject([{ series: "release-notes", state: "sent" }]),
      );
      const sent = publications(link);
      await channel.run(RELEASE_NOTES_ROUTINE.title);

      expect(publications(link)).toEqual(sent);
      expect(sent.map(({ slack_ts }) => slack_ts)).toEqual(postedInChannel(link.slack));
    },
    { turns: 2 },
  );

  suite.scenario(
    "the run leaves the owner's Toy Box and Copilot untouched",
    async () => {
      const catalog = await readCatalog(suite.toyBox.origin);
      const sessions = [
        join(".copilot", "session-state", channel.id),
        join(".toy-box", "sessions", channel.id),
      ];

      expect(catalog.channels.map(({ id }) => id)).toEqual([channel.id]);
      for (const path of sessions) {
        expect(existsSync(join(suite.toyBox.home, path))).toBe(true);
        expect(existsSync(join(homedir(), path))).toBe(false);
      }
    },
    { turns: 0 },
  );
});

/** Asks the lead to add `routine` as given. */
function adding({ title, schedule, prompt }: typeof REQUESTS_ROUTINE) {
  return `a routine titled "${title}" with the schedule "${schedule}" and exactly this prompt: "${prompt}"`;
}

/** What people in C-link see of the message at `ts`: its reactions and the bot's replies to it. */
function seenInSlack(slack: FakeSlack, ts: string) {
  const messages = slack.getMessages("C-link");
  return {
    reactions: messages.find((message) => message.ts === ts)?.reactions,
    replies: messages.filter((message) => message.thread_ts === ts && message.user === BOT).length,
  };
}

/** The link's publications as bridge.db records them, in the order the lead queued them. */
function publications(link: SlackLink) {
  return link.query<{ series: string; state: string; slack_ts: string | null }>(
    "SELECT series, state, slack_ts FROM outbox WHERE kind = 'publication' ORDER BY number",
  );
}

/** The ts of each post the bot made at the top of C-link rather than in a thread. */
function postedInChannel(slack: FakeSlack) {
  return slack
    .getMessages("C-link")
    .filter((message) => message.user === BOT && message.thread_ts === undefined)
    .map(({ ts }) => ts);
}

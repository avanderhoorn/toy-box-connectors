// A Toy Box channel linked to Slack, from a Slack message to the lead acting on it.

import { afterAll, beforeAll, expect } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALICE, BOT, MALLORY, said, timestamps } from "../integration/connectedBridge";
import { linkSlack, REQUESTS_ROUTINE, type SlackLink } from "./slackLink";
import { describeEndToEnd } from "./suite";
import { CREATE_CHANNEL_TIMEOUT, createTestChannel, type TestChannel } from "./testChannel";
import { readCatalog } from "./toyBoxApi";

const { title, schedule, prompt } = REQUESTS_ROUTINE;
const PURPOSE = `Answer the release team's questions from Slack. Tonight's release ships dark mode and faster search. In your kickoff turn, add a routine titled "${title}" with the schedule "${schedule}" and exactly this prompt: "${prompt}" Run toy-box-slack only when a routine asks you to.`;

describeEndToEnd("a channel linked to Slack", (suite) => {
  let channel: TestChannel;
  let link: SlackLink;
  beforeAll(async () => {
    channel = await createTestChannel(suite.toyBox, { name: "Release", purpose: PURPOSE });
    link = await linkSlack(suite.toyBox, channel);
  }, CREATE_CHANNEL_TIMEOUT + 30_000);
  afterAll(() => link?.stop());

  suite.scenario(
    "an allowed person's mention wakes the lead, which queues one answer in its thread, and a stranger's gets nothing",
    async () => {
      const [strangerTs, askedTs] = timestamps(2);
      const ask = `<@${BOT}> what's going out in tonight's release?`;
      const since = Date.now();

      await channel.turn(async () => {
        await link.post(said(MALLORY, strangerTs, ask));
        await link.post(said(ALICE, askedTs, ask));
      });

      // Only the lead's own session can queue the link's reply, and only after inbox showed it.
      expect(
        link.query(
          "SELECT requester_user_id, state FROM requests WHERE root_ts IN (?, ?)",
          strangerTs,
          askedTs,
        ),
      ).toEqual([{ requester_user_id: ALICE, state: "answering" }]);
      expect(
        link.query(
          "SELECT kind, channel_id, thread_ts, state FROM outbox WHERE created_at >= ?",
          since,
        ),
      ).toEqual([{ kind: "reply", channel_id: "C-link", thread_ts: askedTs, state: "queued" }]);
      expect(link.query("SELECT outcome FROM wakes WHERE at >= ?", since)).toEqual([
        { outcome: "ran" },
      ]);
    },
    { turns: 1 },
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

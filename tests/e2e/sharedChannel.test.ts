// Two Toy Box channels that share a Slack channel, each through a Slack app of its own.
//
// The suite runs only with TOY_BOX_SLACK_E2E=1, because its leads spend model credits. Docs links
// C0LINK through the default app and Releases through the releases app its owner adds, so Alice
// tells the leads apart by the bot she mentions. One scenario drives both leads, since each lead's
// silence is half of what the other's answer proves.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FakeSlack } from "../fakes/slack";
import { ALICE, BOT, said, timestamps } from "../integration/connectedBridge";
import { waitFor } from "../integration/waitFor";
import {
  startIsolatedToyBox,
  STARTUP_TIMEOUT,
  STOP_TIMEOUT,
  type IsolatedToyBox,
} from "./isolatedToyBox";
import {
  adding,
  LINK_TIMEOUT,
  linkSlack,
  RELEASES_BOT,
  REQUESTS_ROUTINE,
  type LinkedApp,
  type SlackLink,
} from "./slackLink";
import {
  CREATE_CHANNEL_TIMEOUT,
  createTestChannel,
  TURN_TIMEOUT,
  type TestChannel,
} from "./testChannel";

// The bridge posts an answer within a second of the lead queuing it, which can be after its turn
// ends.
const ANSWER_TIMEOUT = 5_000;

describe.skipIf(process.env.TOY_BOX_SLACK_E2E !== "1")(
  "two channels that share a Slack channel, each through its own app",
  () => {
    let toyBox: IsolatedToyBox;
    let docs: TestChannel;
    let releases: TestChannel;
    let link: SlackLink;
    let releasesApp: LinkedApp;
    beforeAll(
      async () => {
        toyBox = await startIsolatedToyBox();
        [docs, releases] = await Promise.all([
          createTestChannel(toyBox, {
            name: "Docs",
            purpose: purpose("the docs team", "The docs for tonight's release cover dark mode."),
          }),
          createTestChannel(toyBox, {
            name: "Releases",
            purpose: purpose("the release team", "Tonight's release ships dark mode."),
          }),
        ]);
        link = await linkSlack(toyBox, docs);
        releasesApp = await link.addLead(releases);
      },
      STARTUP_TIMEOUT + CREATE_CHANNEL_TIMEOUT + 2 * LINK_TIMEOUT + STOP_TIMEOUT,
    );
    afterAll(async () => {
      try {
        await link?.stop();
      } finally {
        await toyBox?.stop();
      }
    }, STOP_TIMEOUT + 10_000);

    test(
      "each lead answers only what Alice asks its own bot, as that bot, and her reply naming no one reaches only the lead she asked",
      async () => {
        try {
          const since = Date.now();
          const [releasesTs] = timestamps(1, since);
          await docs.idleThrough(async () => {
            await releases.turn(() =>
              link.post(said(ALICE, releasesTs, `<@${RELEASES_BOT}> is tonight's release out?`)),
            );
            await waitFor(
              () => expect(requestsAbout(releasesApp, releasesTs)).toEqual([MENTION_ANSWERED]),
              ANSWER_TIMEOUT,
            );
          });
          expect(requestsAbout(link, releasesTs)).toEqual([]);
          expect(answeredBy(link.slack, releasesTs)).toEqual([RELEASES_BOT]);

          const [docsTs] = timestamps(1, Date.now());
          await releases.idleThrough(async () => {
            await docs.turn(() =>
              link.post(said(ALICE, docsTs, `<@${BOT}> are the docs for tonight's release ready?`)),
            );
            await waitFor(
              () => expect(requestsAbout(link, docsTs)).toEqual([MENTION_ANSWERED]),
              ANSWER_TIMEOUT,
            );
            const [followedTs] = timestamps(1, Date.now());
            await docs.turn(() =>
              link.post(said(ALICE, followedTs, "Do they cover dark mode?", { thread_ts: docsTs })),
            );
            await waitFor(
              () =>
                expect(requestsAbout(link, docsTs)).toEqual([
                  MENTION_ANSWERED,
                  { reason: "follow_up", state: "answered" },
                ]),
              ANSWER_TIMEOUT,
            );
          });
          expect(requestsAbout(releasesApp, docsTs)).toEqual([]);
          expect(answeredBy(link.slack, docsTs)).toEqual([BOT, BOT]);

          expect(wakesSince(releasesApp, since)).toEqual([{ outcome: "ran" }]);
          expect(wakesSince(link, since)).toEqual([{ outcome: "ran" }, { outcome: "ran" }]);
        } catch (error) {
          throw toyBox.failure(error);
        }
      },
      { timeout: 3 * TURN_TIMEOUT + 60_000, retry: 1 },
    );
  },
);

const MENTION_ANSWERED = { reason: "mention", state: "answered" };

/** The purpose of a channel whose lead answers `team` from Slack, knowing `news`. */
function purpose(team: string, news: string) {
  return `Answer ${team}'s questions from Slack. ${news} In your kickoff turn, add ${adding(REQUESTS_ROUTINE)} Run toy-box-slack only when a routine asks you to.`;
}

/** The reason and state of each request `app` opened about the thread at `ts`, oldest first. */
function requestsAbout(app: LinkedApp, ts: string) {
  return app.query<{ reason: string; state: string }>(
    "SELECT reason, state FROM requests WHERE root_ts = ? ORDER BY id",
    ts,
  );
}

/** The bot whose token posted each answer in the thread at `ts` in C0LINK, oldest first. */
function answeredBy(slack: FakeSlack, ts: string) {
  return slack
    .getMessages("C0LINK")
    .filter((message) => message.thread_ts === ts && message.bot_id !== undefined)
    .map(({ user }) => user);
}

/** The outcome of each wake `app` gave its lead since `since`, oldest first. */
function wakesSince(app: LinkedApp, since: number) {
  return app.query<{ outcome: string }>(
    "SELECT outcome FROM wakes WHERE at >= ? ORDER BY at",
    since,
  );
}

// A Toy Box channel linked to Slack, from a Slack message to the lead acting on it.
//
// The suite runs only with TOY_BOX_SLACK_E2E=1, because its lead spends model credits. Its
// scenarios share one isolated Toy Box, channel and link, which stop after the last scenario
// whether they pass or not. A scenario drives real model turns, so it gets one rerun, and its
// timeout outlasts the harness's deadlines, so a failure names what it waited for.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FakeSlack } from "../fakes/slack";
import { ALICE, BOT, MALLORY, said, timestamps } from "../integration/connectedBridge";
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
  REQUESTS_ROUTINE,
  skillRoutine,
  type SlackLink,
} from "./slackLink";
import {
  CREATE_CHANNEL_TIMEOUT,
  createTestChannel,
  TURN_TIMEOUT,
  type TestChannel,
} from "./testChannel";

const RELEASE_NOTES_ROUTINE = skillRoutine("Release notes");
const DIGEST_ROUTINE = skillRoutine("Slack digest");
const PURPOSE = `Answer the release team's questions from Slack, publish release notes there, and digest what they say here. Tonight's release ships dark mode and faster search. In your kickoff turn, add ${adding(REQUESTS_ROUTINE)} Then add ${adding(RELEASE_NOTES_ROUTINE)} Then add ${adding(DIGEST_ROUTINE)} Run toy-box-slack only when a routine or the owner asks you to.`;
const SCREENSHOT = readFileSync(join(import.meta.dir, "..", "fixtures", "build-error.png"));
/** The runner the screenshot's error names, drawn in its pixels and written nowhere else. */
const SCREENSHOT_RUNNER = "OSPREY-93";

describe.skipIf(process.env.TOY_BOX_SLACK_E2E !== "1")("a channel linked to Slack", () => {
  let toyBox: IsolatedToyBox;
  let channel: TestChannel;
  let link: SlackLink;
  beforeAll(
    async () => {
      toyBox = await startIsolatedToyBox();
      channel = await createTestChannel(toyBox, { name: "Release", purpose: PURPOSE });
      link = await linkSlack(toyBox, channel);
    },
    STARTUP_TIMEOUT + CREATE_CHANNEL_TIMEOUT + LINK_TIMEOUT + STOP_TIMEOUT,
  );
  afterAll(async () => {
    try {
      await link?.stop();
    } finally {
      await toyBox?.stop();
    }
  }, STOP_TIMEOUT + 10_000);

  /** A test that wakes the lead for `turns` turns. */
  function scenario(name: string, run: () => Promise<void>, { turns }: { turns: number }) {
    test(
      name,
      async () => {
        try {
          await run();
        } catch (error) {
          throw toyBox.failure(error);
        }
      },
      { timeout: turns * TURN_TIMEOUT + 60_000, retry: 1 },
    );
  }

  scenario(
    "an allowed person's mention wakes the lead, which answers once in their thread, and a stranger's gets nothing",
    async () => {
      // From now, since nothing said before the owner linked C0LINK asks the lead.
      const [strangerTs, askedTs] = timestamps(2, Date.now());
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
      ).toEqual([{ kind: "reply", channel_id: "C0LINK", thread_ts: askedTs, state: "sent" }]);
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

  scenario(
    "a restart mid-conversation answers what Alice said while the bridge was down, once",
    async () => {
      const [askedTs] = timestamps(1, Date.now());
      await channel.turn(() =>
        link.post(said(ALICE, askedTs, `<@${BOT}> does tonight's release include dark mode?`)),
      );
      await waitFor(() => expect(seenInSlack(link.slack, askedTs).replies).toBe(1));

      // Slack sends a bridge that isn't running no event, so only catching up finds her follow-up.
      await channel.turn(() =>
        link.restart(() => {
          const [followedTs] = timestamps(1, Date.now());
          const followUp = said(ALICE, followedTs, "What else ships with it?", {
            thread_ts: askedTs,
          });
          link.slack.setMessage("C0LINK", followUp);
        }),
      );

      await waitFor(() =>
        expect(
          link.query("SELECT reason, state FROM requests WHERE root_ts = ? ORDER BY id", askedTs),
        ).toEqual([
          { reason: "mention", state: "answered" },
          { reason: "follow_up", state: "answered" },
        ]),
      );
      expect(seenInSlack(link.slack, askedTs).replies).toBe(2);
    },
    { turns: 2 },
  );

  scenario(
    "Alice's question about the log and screenshot she shares gets an answer only they hold",
    async () => {
      const [askedTs] = timestamps(1, Date.now());
      // Each file names a runner nothing else does, and the screenshot names its runner only in its
      // pixels, so the answer names both only if the lead read the log and viewed the screenshot.
      const log = link.slack.addFile(
        "$ bun run deploy --stage canary\nerror: runner PELICAN-48 lost its connection mid-migration\nDeploy 4127 failed.\n",
        { user: ALICE, name: "deploy.log" },
      );
      const screenshot = link.slack.addFile(SCREENSHOT, {
        user: ALICE,
        name: "build-error.png",
        mimetype: "image/png",
      });

      const ask = `<@${BOT}> which runners should I check before we retry the deploy?`;
      await channel.turn(() =>
        link.post(said(ALICE, askedTs, ask, { subtype: "file_share", files: [log, screenshot] })),
      );

      // The bridge posts the answer once the lead queues it, so the lead's turn can end first.
      await waitFor(() => expect(seenInSlack(link.slack, askedTs).replies).toBe(1));
      const [answer] = link.slack
        .getMessages("C0LINK")
        .filter((message) => message.thread_ts === askedTs && message.user === BOT);
      expect(answer.text).toContain("PELICAN-48");
      expect(answer.text).toContain(SCREENSHOT_RUNNER);
    },
    { turns: 1 },
  );

  scenario(
    "release notes post once in the channel when their routine runs twice",
    async () => {
      // The routine publishes only what git says shipped since its previous run.
      ship(toyBox, "Add dark mode", "Speed up search");
      // Both tries share a scheduled slot, so a rerun checks every publication, not only its own.
      await channel.run(RELEASE_NOTES_ROUTINE.title);
      await waitFor(() =>
        expect(publications(link)).toMatchObject([{ series: "release-notes", state: "sent" }]),
      );
      const sent = publications(link);
      // A fix ships after the notes go out, so the second run has news for a slot already used.
      ship(toyBox, "Fix the search box in dark mode on Safari");
      await channel.run(RELEASE_NOTES_ROUTINE.title);

      expect(publications(link)).toEqual(sent);
      expect(sent.map(({ slack_ts }) => slack_ts)).toEqual(postedInChannel(link.slack));
    },
    { turns: 2 },
  );

  scenario(
    "a digest posts once in the Toy Box channel when its routine runs twice",
    async () => {
      const [ts] = timestamps(1, Date.now());
      const problem =
        "QA found the search box unreadable in dark mode on Safari, so tonight's release waits on a fix.";
      await link.post(said(ALICE, ts, problem));
      const [{ seq }] = link.query<{ seq: number }>(
        "SELECT updated_seq AS seq FROM messages WHERE ts = ?",
        ts,
      );
      const posts = await channel.leadPosts();

      // Alice's message is the link's latest change, so a digest that read it reads through it.
      await channel.run(DIGEST_ROUTINE.title);
      expect(digestCursor(link)).toEqual([{ read: seq, shown: seq }]);
      expect(await channel.leadPosts()).toBe(posts + 1);

      await channel.run(DIGEST_ROUTINE.title);
      expect(digestCursor(link)).toEqual([{ read: seq, shown: seq }]);
      expect(await channel.leadPosts()).toBe(posts + 1);
    },
    { turns: 2 },
  );

  scenario(
    "the owner's ask in Toy Box posts once at the top of the Slack channel, notifying nobody",
    async () => {
      const since = Date.now();
      const posted = postedInChannel(link.slack);
      await channel.turn(() =>
        channel.say("Tell the release team in Slack that tonight's release moves to 9pm."),
      );

      const slackTs = await postedSince(link, since);
      expect(postedInChannel(link.slack)).toEqual([...posted, slackTs]);
      expect(notifiedBy(link.slack, slackTs)).toEqual([]);
    },
    { turns: 1 },
  );

  scenario(
    "the owner's ask to notify Alice posts once, mentioning her by the member ID status shows",
    async () => {
      const since = Date.now();
      await channel.turn(() =>
        channel.say("Post in Slack that QA signs off at 8pm tonight, and make sure Alice sees it."),
      );

      expect(notifiedBy(link.slack, await postedSince(link, since))).toEqual([ALICE]);
    },
    { turns: 1 },
  );

  scenario(
    "Alice's ask in Slack for a channel post goes to the owner, and nothing posts",
    async () => {
      const [askedTs] = timestamps(1, Date.now());
      const since = Date.now();
      const requests = await channel.leadRequests();

      await channel.turn(() =>
        link.post(
          said(
            ALICE,
            askedTs,
            `<@${BOT}> post in the channel that nobody merges to main until QA signs off, please.`,
          ),
        ),
      );

      // Whatever the lead tells Alice in her thread, only the owner can have it post.
      expect(await channel.leadRequests()).toBe(requests + 1);
      expect(
        link.query("SELECT kind FROM outbox WHERE kind != 'reply' AND created_at >= ?", since),
      ).toEqual([]);
    },
    { turns: 1 },
  );

  scenario(
    "the run leaves the owner's Toy Box and Copilot untouched",
    async () => {
      const sessions = [
        join(".copilot", "session-state", channel.id),
        join(".toy-box", "sessions", channel.id),
      ];

      for (const path of sessions) {
        expect(existsSync(join(toyBox.home, path))).toBe(true);
        expect(existsSync(join(homedir(), path))).toBe(false);
      }
    },
    { turns: 0 },
  );
});

/** Commits `subjects` to main in the channel's folder, making it a repository if it isn't one. */
function ship(toyBox: IsolatedToyBox, ...subjects: string[]) {
  const identity = ["-c", "user.name=Dana", "-c", "user.email=dana@test"];
  const commits = subjects.map((subject) => ["commit", "-q", "--allow-empty", "-m", subject]);
  for (const args of [["init", "-q", "-b", "main"], ...commits]) {
    const git = Bun.spawnSync(["git", ...identity, ...args], {
      cwd: toyBox.work,
      env: { PATH: process.env.PATH, HOME: toyBox.home },
      stderr: "pipe",
    });
    if (!git.success) throw new Error(`git ${args.join(" ")} failed:\n${git.stderr.toString()}`);
  }
}

/** What people in C0LINK see of the message at `ts`: its reactions and the bot's replies to it. */
function seenInSlack(slack: FakeSlack, ts: string) {
  const messages = slack.getMessages("C0LINK");
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

/** How far the lead has marked the link's activity read, and how far activity has shown it. */
function digestCursor(link: SlackLink) {
  return link.query<{ read: number; shown: number }>(
    "SELECT through_seq AS read, served_through_seq AS shown FROM cursors",
  );
}

/** The ts of each post the bot made at the top of C0LINK rather than in a thread. */
function postedInChannel(slack: FakeSlack) {
  return slack
    .getMessages("C0LINK")
    .filter((message) => message.user === BOT && message.thread_ts === undefined)
    .map(({ ts }) => ts);
}

/**
 * The ts of the one post the lead queued since `since`, once it's sent at the top of the channel.
 * The bridge posts once the lead queues it, so the lead's turn can end first.
 */
async function postedSince(link: SlackLink, since: number) {
  await waitFor(() =>
    expect(
      link.query("SELECT kind, thread_ts, state FROM outbox WHERE created_at >= ?", since),
    ).toEqual([{ kind: "post", thread_ts: null, state: "sent" }]),
  );
  const [{ slack_ts }] = link.query<{ slack_ts: string }>(
    "SELECT slack_ts FROM outbox WHERE created_at >= ?",
    since,
  );
  return slack_ts;
}

/** Whom the bot's message at `ts` in C0LINK notifies: everyone its markdown block mentions. */
function notifiedBy(slack: FakeSlack, ts: string) {
  const { blocks } = slack.getMessages("C0LINK").find((message) => message.ts === ts)!;
  const [{ text }] = blocks as [{ text: string }];
  return Array.from(text.matchAll(/<@([UW][A-Z0-9]+)>/g), ([, userId]) => userId);
}

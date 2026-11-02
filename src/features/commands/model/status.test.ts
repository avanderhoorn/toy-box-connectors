import { expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import {
  presentAppStatuses,
  presentStatus,
  unconfiguredSlack,
  type LinkStatus,
  type SlackState,
} from "./status";

const connected: SlackState = { connection: "connected", problem: null };
const link: LinkStatus = {
  toyBoxChannelId: "toybox-link",
  toyBoxChannel: '"Releases"',
  slackChannelId: "C-link",
  slackChannel: "#release-eng",
  status: "active",
  statusReason: null,
  requestMode: "mention",
  observe: "requesters",
  allowlist: [],
  pending: 0,
  read: 0,
  unconfirmed: [],
  wake: { kind: "idle" },
  lastWake: null,
};

test("Slack is set up once both tokens are, and until then serve asks the owner for each missing one", () => {
  const shown = (tokens: Parameters<typeof unconfiguredSlack>[0], app = DEFAULT_APP) => {
    const slack = unconfiguredSlack(tokens, app);
    return slack && presentStatus({ slack, links: [] }, 0).split("\n")[1];
  };

  expect(shown({ botToken: "xoxb-1", appToken: "xapp-1" })).toBeNull();
  expect(shown({ botToken: null, appToken: "xapp-1" })).toBe(
    "Not set up. Have the owner run `toy-box-slack serve` at their own terminal, which asks for SLACK_BOT_TOKEN, and then restart the bridge.",
  );
  expect(shown({ botToken: "xoxb-1", appToken: null })).toBe(
    "Not set up. Have the owner run `toy-box-slack serve` at their own terminal, which asks for SLACK_APP_TOKEN, and then restart the bridge.",
  );
  expect(shown({ botToken: null, appToken: null })).toBe(
    "Not set up. Have the owner run `toy-box-slack serve` at their own terminal, which asks for SLACK_BOT_TOKEN and SLACK_APP_TOKEN, and then restart the bridge.",
  );
  expect(shown({ botToken: "xoxb-1", appToken: null }, "releases")).toBe(
    "Not set up. Have the owner run `toy-box-slack serve` at their own terminal, which asks for the releases app's SLACK_APP_TOKEN, and then restart the bridge.",
  );
});

test("each fix a link's status gives names its Toy Box channel, so it runs as printed at a terminal", () => {
  const line = (changes: Partial<LinkStatus>, starts: string) =>
    presentStatus({ slack: connected, links: [{ ...link, ...changes }] }, 60_000)
      .split("\n")
      .find((shown) => shown.startsWith(starts));

  expect(line({ status: "paused" }, "- Link:")).toBe(
    "- Link: paused, so nothing new opens and nothing posts. Have the owner run `toy-box-slack resume --channel toybox-link`.",
  );
  expect(line({ status: "suspended", statusReason: "bot_removed" }, "- Link:")).toBe(
    "- Link: suspended because the bot was removed from its Slack channel, so nothing new opens and nothing posts. Invite the bot back to the channel, then have the owner run `toy-box-slack resume --channel toybox-link`.",
  );
  expect(line({ lastWake: { at: 0, outcome: "missing" } }, "- Wakes:")).toContain(
    "Create that routine, or run `toy-box-slack unlink --channel toybox-link` if the channel is gone. Last checked 1 minute ago.",
  );
});

test("a wake Toy Box refused says the bridge retries it, and when it last tried", () => {
  const wake = { kind: "wait", until: 90_000 } as const;
  const lastWake = { at: 0, outcome: "refused" } as const;
  const shown = presentStatus({ slack: connected, links: [{ ...link, wake, lastWake }] }, 60_000);

  expect(shown.split("\n").find((line) => line.startsWith("- Wakes:"))).toBe(
    "- Wakes: next wake in less than a minute. Toy Box refused the last wake, so the bridge retries. It last tried 1 minute ago.",
  );
});

test("says whom a link answers, by name and member ID, and when, for one person, several or nobody yet", () => {
  const answers = (changes: Partial<LinkStatus>) =>
    presentStatus({ slack: connected, links: [{ ...link, ...changes }] }, 0)
      .split("\n")
      .find((line) => line.startsWith("- Answers:"));
  const ada = { userId: "U0ADA", name: "Ada" };
  const bo = { userId: "U0BO", name: "Bo" };

  expect(answers({ allowlist: [ada] })).toBe(
    "- Answers: Ada (U0ADA) when they mention the bot. Threads show only the people it answers.",
  );
  expect(answers({ allowlist: [ada, bo], requestMode: "all", observe: "channel" })).toBe(
    "- Answers: Ada (U0ADA) and Bo (U0BO) when they post or mention the bot. Threads show everyone.",
  );
  expect(answers({ allowlist: [] })).toBe(
    "- Answers: nobody yet. Threads show only the people it answers.",
  );
});

test("shows each app's status under its name, saying when no Toy Box channel links through one", () => {
  const refused: SlackState = { connection: "refused", problem: "Have the owner fix it." };

  const shown = presentAppStatuses(
    [
      { app: "default", slack: refused, links: [] },
      { app: "releases", slack: connected, links: [link] },
    ],
    0,
  );

  expect(shown).toBe(
    [
      "# The default app",
      "",
      "## Slack",
      "Off. Have the owner fix it.",
      "",
      "No Toy Box channel links through the default app yet.",
      "",
      "# The releases app",
      "",
      presentStatus({ slack: connected, links: [link] }, 0),
    ].join("\n"),
  );
  expect(shown).toContain('## #release-eng and Toy Box channel "Releases"\n- Link: active.');
});

import { expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import {
  presentAppStatuses,
  presentStatus,
  unconfiguredSlack,
  type LinkStatus,
  type SlackState,
} from "./status";

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

test("shows each app's status under its name, saying when no Toy Box channel links through one", () => {
  const connected: SlackState = { connection: "connected", problem: null };
  const refused: SlackState = { connection: "refused", problem: "Have the owner fix it." };
  const link: LinkStatus = {
    toyBoxChannelId: "toybox-link",
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
  expect(shown).toContain("## #release-eng and Toy Box channel toybox-link\n- Link: active.");
});

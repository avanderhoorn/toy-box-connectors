import { expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import { presentStatus, unconfiguredSlack } from "./status";

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

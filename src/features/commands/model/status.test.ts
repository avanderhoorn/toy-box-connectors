import { describe, expect, test } from "bun:test";
import { presentStatus, unconfiguredSlack, type LinkStatus, type StatusResult } from "./status";

const AT = Date.parse("2026-10-27T16:00:00Z");

const healthy: LinkStatus = {
  id: "link",
  toyBoxChannelId: "release-eng",
  slackChannelId: "C0RELEASE",
  status: "active",
  statusReason: null,
  coverage: "complete",
  following: true,
  wake: { kind: "idle" },
  routines: [{ series: null, routineId: "routine-requests", period: null, state: "present" }],
};

function status(links: LinkStatus[], overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    slack: { connection: "connected", problem: null },
    toyBox: "http://127.0.0.1:3000",
    channelId: null,
    links,
    ...overrides,
  };
}

describe("presenting status", () => {
  test("a healthy link reads as a short list under its channels", () => {
    expect(presentStatus(status([healthy]), { at: AT })).toBe(
      [
        "## Slack\nConnected.",
        "Toy Box: http://127.0.0.1:3000",
        [
          "## Toy Box channel release-eng and Slack channel C0RELEASE",
          "- Link: active.",
          "- Coverage: complete.",
          "- Toy Box: following the channel",
          "- Wakes: nothing is waiting for the lead.",
          "- Requests routine: routine-requests.",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  test("says what to do about each thing that's wrong", () => {
    const troubled: LinkStatus = {
      ...healthy,
      status: "suspended",
      statusReason: "bot_removed",
      coverage: "partial",
      following: false,
      wake: { kind: "blocked", reason: "routine_missing" },
      routines: [
        { series: null, routineId: "routine-requests", period: null, state: "missing" },
        { series: "release-notes", routineId: "routine-notes", period: "week", state: "drifted" },
      ],
    };
    const slack = { connection: "unconfigured", problem: "SLACK_APP_TOKEN isn't set." } as const;

    expect(presentStatus(status([troubled], { slack }), { at: AT }).split("\n")).toEqual([
      "## Slack",
      "Not set up. SLACK_APP_TOKEN isn't set.",
      "",
      "Toy Box: http://127.0.0.1:3000",
      "",
      "## Toy Box channel release-eng and Slack channel C0RELEASE",
      "- Link: suspended because the bot was removed from its Slack channel, so nothing new opens and posts wait. Invite the bot back to the channel, then run `toy-box-slack resume` for the owner to approve in Slack.",
      "- Coverage: partial, a repair couldn't finish, so some messages may be missing.",
      "- Toy Box: not following the channel's stream yet, retrying",
      "- Wakes: blocked, because the requests routine is gone. Register a new one with `toy-box-slack routine --requests <id>`.",
      "- Requests routine: routine-requests was deleted. Register a new one with `toy-box-slack routine --requests <id>`.",
      "- Routine for release-notes: routine-notes no longer runs `toy-box-slack publish --series release-notes`. Put that back in its prompt in Toy Box, or register another with `toy-box-slack routine --publish <id> --series release-notes --period week`.",
    ]);
  });

  test("words each wake decision, rounding the next wake up to a minute", () => {
    const wake = (decision: LinkStatus["wake"]) =>
      presentStatus(status([{ ...healthy, wake: decision }]), { at: AT })
        .split("\n")
        .find((line) => line.startsWith("- Wakes: "));

    expect(wake(null)).toBe("- Wakes: not decided yet");
    expect(wake({ kind: "wake", reason: "requests" })).toBe("- Wakes: waking the lead now.");
    expect(wake({ kind: "wait", until: AT + 90_000 })).toBe("- Wakes: next wake in about 2 min.");
    expect(wake({ kind: "wait", until: AT - 1 })).toBe("- Wakes: next wake in about 1 min.");
    expect(wake({ kind: "wait", until: "lead_idle" })).toBe(
      "- Wakes: waiting for the lead's turn to end.",
    );
    expect(wake({ kind: "stalled" })).toStartWith("- Wakes: stalled. The lead was woken");
    expect(wake({ kind: "blocked", reason: "link_inactive" })).toBe(
      "- Wakes: off while the link isn't active.",
    );
    expect(wake({ kind: "blocked", reason: "routine_missing" })).toBe(
      "- Wakes: blocked, because the requests routine is gone. Register a new one with `toy-box-slack routine --requests <id>`.",
    );
    expect(wake({ kind: "blocked", reason: "provider" })).toBe(
      "- Wakes: blocked for good, because the channel's lead doesn't run on Copilot. Create a Copilot channel and link that instead.",
    );
    expect(wake({ kind: "blocked", reason: "refused" })).toBe(
      "- Wakes: blocked, because Toy Box refused to run the requests routine. Register a new one with `toy-box-slack routine --requests <id>`.",
    );
  });

  test("a deleted Toy Box channel's link can only be removed", () => {
    const deleted = { ...healthy, status: "suspended", statusReason: "toybox_channel_deleted" };
    expect(presentStatus(status([deleted] as LinkStatus[]), { at: AT })).toContain(
      "- Link: suspended because its Toy Box channel was deleted, so nothing new opens and posts wait. Run `toy-box-slack unlink` to remove the link.",
    );
  });

  test("still says how to resume a link suspended for a reason this version doesn't know", () => {
    const unknown = { ...healthy, status: "suspended", statusReason: "restricted_action" };
    expect(presentStatus(status([unknown] as LinkStatus[]), { at: AT })).toContain(
      "- Link: suspended (restricted_action), so nothing new opens and posts wait. Fix what suspended it, then run `toy-box-slack resume` for the owner to approve in Slack.",
    );
  });

  test("says when nothing is linked, and how to link a channel", () => {
    expect(presentStatus(status([]), { at: AT })).toEndWith(
      "No Toy Box channel is linked to Slack yet.",
    );
    expect(presentStatus(status([], { channelId: "design" }), { at: AT })).toEndWith(
      "Toy Box channel design isn't linked to Slack. Run `toy-box-slack link --slack-channel <id> --routine <id>` to link it.",
    );
  });
});

describe("Slack without its tokens", () => {
  test("names each missing token", () => {
    expect(unconfiguredSlack({ botToken: "xoxb-1", appToken: "xapp-1" })).toBeNull();
    expect(unconfiguredSlack({ botToken: "xoxb-1", appToken: null })).toEqual({
      connection: "unconfigured",
      problem:
        "SLACK_APP_TOKEN isn't set. Add it to credentials.env in the bridge's data folder, then restart the bridge.",
    });
    expect(unconfiguredSlack({ botToken: null, appToken: null })?.problem).toStartWith(
      "SLACK_BOT_TOKEN and SLACK_APP_TOKEN aren't set. Add them to",
    );
  });
});

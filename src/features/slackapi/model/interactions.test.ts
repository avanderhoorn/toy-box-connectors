import { describe, expect, test } from "bun:test";
import { readInteraction } from "./interactions";

/** Alice's click on a button in message 1700000200.000100 in C-link, as Slack sends it. */
function blockActions(changes: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    api_app_id: "A-app",
    team: { id: "T-home", domain: "home" },
    user: { id: "U-alice", username: "alice", name: "alice", team_id: "T-home" },
    token: "deprecated-verification-token",
    trigger_id: "1.2.3",
    container: {
      type: "message",
      message_ts: "1700000200.000100",
      channel_id: "C-link",
      is_ephemeral: false,
    },
    channel: { id: "C-link", name: "link" },
    message: { type: "message", bot_id: "B-bot", ts: "1700000200.000100", text: "a4" },
    response_url: "https://hooks.slack.com/actions/1",
    actions: [
      {
        type: "button",
        action_id: "approval.approve",
        block_id: "decide",
        text: { type: "plain_text", text: "Approve" },
        value: "approval-1",
        action_ts: "1700000300.000100",
      },
    ],
    ...changes,
  };
}

describe("reading interactions", () => {
  test("a click on a button reads as who clicked what, on which message, for which app and team", () => {
    expect(readInteraction(blockActions())).toEqual({
      kind: "block_actions",
      click: {
        appId: "A-app",
        teamId: "T-home",
        userId: "U-alice",
        actions: [{ actionId: "approval.approve", value: "approval-1" }],
        message: { channelId: "C-link", ts: "1700000200.000100" },
      },
    });
  });

  test("an org-wide install's null team and a button without a value read as null", () => {
    const payload = blockActions({
      team: null,
      enterprise: { id: "E-org" },
      is_enterprise_install: true,
      actions: [{ type: "button", action_id: "approval.approve", block_id: "decide" }],
    });
    expect(readInteraction(payload)).toMatchObject({
      kind: "block_actions",
      click: { teamId: null, actions: [{ actionId: "approval.approve", value: null }] },
    });
  });

  test("a click that wasn't on a message the channel can see names no message", () => {
    const surfaces = [
      {
        type: "message",
        message_ts: "1700000200.000100",
        channel_id: "C-link",
        is_ephemeral: true,
      },
      { type: "message_attachment", message_ts: "1700000200.000100", channel_id: "C-link" },
      { type: "view", view_id: "V-home" },
      { type: "message", channel_id: "C-link" },
    ];
    for (const container of surfaces) {
      expect(readInteraction(blockActions({ container }))).toMatchObject({
        kind: "block_actions",
        click: { message: null },
      });
    }
  });

  test("a payload that leaves out its actions has none", () => {
    const { actions: _actions, ...payload } = blockActions();
    expect(readInteraction(payload)).toMatchObject({
      kind: "block_actions",
      click: { actions: [] },
    });
  });

  test("other interactions pass on by type", () => {
    for (const type of ["shortcut", "message_action", "view_submission", "interactive_message"]) {
      expect(readInteraction({ type, callback_id: "x" })).toEqual({ kind: "other", type });
    }
  });

  test("a payload it can't read is malformed, naming issue codes and paths only", () => {
    expect(readInteraction("block_actions")).toEqual({
      kind: "malformed",
      issues: ["invalid_type"],
    });
    expect(readInteraction(blockActions({ user: { name: "alice" } }))).toEqual({
      kind: "malformed",
      issues: ["invalid_type at user.id"],
    });
    expect(
      readInteraction(blockActions({ container: { type: "message", message_ts: "soon" } })),
    ).toEqual({ kind: "malformed", issues: ["invalid_format at container.message_ts"] });
    expect(readInteraction(blockActions({ api_app_id: "" }))).toEqual({
      kind: "malformed",
      issues: ["too_small at api_app_id"],
    });
  });
});

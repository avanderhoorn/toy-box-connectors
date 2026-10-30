import { expect, test } from "bun:test";
import type { SuspendReason } from "@links/model/status";
import type { EventCallback } from "@slackapi/model/envelopes";
import { readSlackEvent } from "@slackapi/model/events";
import { acksInTime, lifecycleAction, type LifecycleAction } from "./receiver";

test("a delivery is acked only while Slack still waits for it", () => {
  expect(acksInTime(1_000, 3_500)).toBe(true);
  expect(acksInTime(1_000, 3_501)).toBe(false);
  // A clock stepped back while the delivery committed still committed it in time.
  expect(acksInTime(1_000, 500)).toBe(true);
});

const ts = "1700000000.000100";
const notice = (subtype: string) => ({ type: "message", subtype, user: "U-owner", ts });
const suspend = (reason: SuspendReason): LifecycleAction => ({
  kind: "suspend",
  channelId: "C-link",
  reason,
});
const uninstall: LifecycleAction = { kind: "uninstall" };
const revoked = (...bot: string[]) => ({ type: "tokens_revoked", tokens: { bot } });

test.each<[string, LifecycleAction | null, EventCallback["event"]]>([
  ["an archive notice", suspend("channel_archived"), notice("channel_archive")],
  ["a private archive notice", suspend("channel_archived"), notice("group_archive")],
  ["an archived channel", suspend("channel_archived"), { type: "channel_archive" }],
  ["a deleted channel", suspend("channel_not_found"), { type: "channel_deleted" }],
  ["a deleted private channel", suspend("channel_not_found"), { type: "group_deleted" }],
  ["a shared channel", suspend("workspace_joined"), { type: "channel_shared" }],
  [
    "a new channel ID",
    suspend("channel_id_changed"),
    { type: "channel_id_changed", old_channel_id: "C-link", new_channel_id: "C-new" },
  ],
  ["our bot's token revoked", uninstall, revoked("U-other", "U-bot")],
  ["another bot's token revoked", null, revoked("U-other")],
  [
    "an edit of a notice",
    null,
    { type: "message", subtype: "message_changed", message: notice("channel_archive") },
  ],
])("%s means %j for the channel's links", (_, action, event) => {
  expect(lifecycleAction(readSlackEvent({ channel: "C-link", ...event }), "U-bot")).toEqual(action);
});

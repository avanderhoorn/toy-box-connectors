import { describe, expect, test } from "bun:test";
import type { EventCallback } from "@slackapi/model/envelopes";
import { readSlackEvent } from "@slackapi/model/events";
import {
  acksInTime,
  lifecycleAction,
  receiptKey,
  receiptType,
  type SlackDelivery,
} from "./receiver";

const callback: EventCallback = {
  teamId: "T-home",
  appId: "A-app",
  authorizations: null,
  eventId: "Ev1",
  eventTime: 1700000000,
  event: { type: "member_joined_channel", channel: "C-link", user: "U-bot" },
};

const deliveries = {
  event: { kind: "event", envelopeId: "env-1", callback },
  rateLimited: {
    kind: "rate_limited",
    envelopeId: "env-2",
    teamId: "T-home",
    appId: "A-app",
    minute: 1700000040,
  },
  bareRateLimited: {
    kind: "rate_limited",
    envelopeId: null,
    teamId: "T-home",
    appId: "A-app",
    minute: 1700000040,
  },
  other: { kind: "other", type: "interactive", envelopeId: "env-4" },
  malformed: {
    kind: "malformed",
    envelopeId: "env-5",
    hint: { channelId: null, eventTime: null },
    issues: [],
  },
  unreadable: {
    kind: "malformed",
    envelopeId: null,
    hint: { channelId: null, eventTime: null },
    issues: ["invalid_json"],
  },
} satisfies Record<string, SlackDelivery>;

describe("receipts", () => {
  test("a receipt is keyed by what a redelivery repeats, and an event by its ID", () => {
    expect(receiptKey(deliveries.event)).toBe("Ev1");
    expect(receiptKey({ ...deliveries.event, envelopeId: "env-redelivered" })).toBe("Ev1");
    expect(receiptKey(deliveries.other)).toBe("env-4");
    expect(receiptKey(deliveries.malformed)).toBe("env-5");
    expect(receiptKey(deliveries.unreadable)).toBeNull();
  });

  test("a rate limit is keyed by its minute, app and workspace, however it arrived", () => {
    const key = "app_rate_limited:A-app:T-home:1700000040";
    expect(receiptKey(deliveries.rateLimited)).toBe(key);
    expect(receiptKey(deliveries.bareRateLimited)).toBe(key);
    expect(receiptKey({ ...deliveries.rateLimited, teamId: "T-other" })).not.toBe(key);
  });

  test("a receipt names its event's type, or its frame's", () => {
    expect(receiptType(deliveries.event)).toBe("member_joined_channel");
    expect(receiptType(deliveries.rateLimited)).toBe("app_rate_limited");
    expect(receiptType(deliveries.other)).toBe("interactive");
    expect(receiptType(deliveries.malformed)).toBe("unknown");
  });
});

test("a delivery is acked only while Slack still waits for it", () => {
  expect(acksInTime(1_000, 1_000)).toBe(true);
  expect(acksInTime(1_000, 3_500)).toBe(true);
  expect(acksInTime(1_000, 3_501)).toBe(false);
  // A clock stepped back while the delivery committed still committed it in time.
  expect(acksInTime(1_000, 500)).toBe(true);
});

describe("what an event means for the links on its channel", () => {
  const action = (event: EventCallback["event"]) =>
    lifecycleAction(readSlackEvent({ channel: "C-link", ...event }), "U-bot");
  const notice = (subtype: string) =>
    action({ type: "message", subtype, user: "U-owner", ts: "1700000000.000100" });

  test("a notice about the channel suspends or invalidates it, and any other message nothing", () => {
    expect(notice("channel_convert_to_public")).toEqual({
      kind: "suspend",
      channelId: "C-link",
      reason: "channel_made_public",
    });
    for (const subtype of ["channel_archive", "group_archive"]) {
      expect(notice(subtype)).toEqual({
        kind: "suspend",
        channelId: "C-link",
        reason: "channel_archived",
      });
    }
    for (const subtype of [
      "channel_convert_to_private",
      "channel_unarchive",
      "group_unarchive",
      "channel_name",
      "group_name",
    ]) {
      expect(notice(subtype)).toEqual({ kind: "invalidate", channelId: "C-link" });
    }
    expect(notice("channel_join")).toBeNull();
    expect(action({ type: "message", user: "U-owner", ts: "1700000000.000100" })).toBeNull();
  });

  test("an edit or a delete of a notice changes nothing about the channel", () => {
    const archived = {
      type: "message",
      subtype: "channel_archive",
      user: "U-owner",
      ts: "1700000000.000100",
    };
    expect(action({ type: "message", subtype: "message_changed", message: archived })).toBeNull();
    expect(
      action({ type: "message", subtype: "message_deleted", deleted_ts: archived.ts }),
    ).toBeNull();
  });

  test("our bot leaving suspends the channel, and joining invalidates it", () => {
    const member = (type: string, user: string) => action({ type, user });
    expect(member("member_left_channel", "U-bot")).toEqual({
      kind: "suspend",
      channelId: "C-link",
      reason: "bot_removed",
    });
    expect(member("member_joined_channel", "U-bot")).toEqual({
      kind: "invalidate",
      channelId: "C-link",
    });
    expect(member("member_left_channel", "U-owner")).toBeNull();
    expect(member("member_joined_channel", "U-owner")).toBeNull();
  });

  test("an archived or deleted channel is suspended, and any other change invalidates it", () => {
    expect(action({ type: "channel_archive", user: "U-owner" })).toEqual({
      kind: "suspend",
      channelId: "C-link",
      reason: "channel_archived",
    });
    expect(action({ type: "channel_deleted" })).toEqual({
      kind: "suspend",
      channelId: "C-link",
      reason: "channel_not_found",
    });
    for (const type of ["channel_shared", "channel_unshared"]) {
      expect(action({ type })).toEqual({ kind: "invalidate", channelId: "C-link" });
    }
    expect(
      action({ type: "channel_rename", channel: { id: "C-link", name: "new", created: 1 } }),
    ).toEqual({ kind: "invalidate", channelId: "C-link" });
  });

  test("a new channel ID moves the channel", () => {
    expect(
      action({ type: "channel_id_changed", old_channel_id: "C-link", new_channel_id: "C-new" }),
    ).toEqual({ kind: "move", oldChannelId: "C-link", newChannelId: "C-new" });
  });

  test("uninstalling the app, or revoking our bot's token, uninstalls", () => {
    expect(action({ type: "app_uninstalled" })).toEqual({ kind: "uninstall" });
    const revoked = (bot: string[]) => action({ type: "tokens_revoked", tokens: { bot } });
    expect(revoked(["U-other", "U-bot"])).toEqual({ kind: "uninstall" });
    expect(revoked(["U-other"])).toBeNull();
  });

  test("a deleted file, an event the bridge doesn't use or a malformed one means nothing", () => {
    expect(action({ type: "file_deleted", file_id: "F1" })).toBeNull();
    expect(action({ type: "reaction_added" })).toBeNull();
    expect(action({ type: "member_left_channel" })).toBeNull();
  });
});

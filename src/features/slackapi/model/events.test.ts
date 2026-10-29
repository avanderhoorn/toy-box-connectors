import { expect, test } from "bun:test";
import type { EventCallback } from "./envelopes";
import { isForInstallation, readSlackEvent } from "./events";

test("event decoding retains lifecycle targets and never repeats malformed content", () => {
  expect(
    readSlackEvent({ type: "channel_id_changed", old_channel_id: "G1", new_channel_id: "C2" }),
  ).toMatchObject({ kind: "channel_id_changed", oldChannelId: "G1", newChannelId: "C2" });
  expect(readSlackEvent({ type: "tokens_revoked", tokens: { bot: ["UBOT"] } })).toEqual({
    kind: "tokens_revoked",
    botUserIds: ["UBOT"],
  });
  const result = readSlackEvent({
    type: "message",
    channel: "C1",
    ts: "bad",
    text: "private content",
  });
  expect(result).toMatchObject({ kind: "malformed", channelId: "C1" });
  expect(JSON.stringify(result)).not.toContain("private content");
  expect(readSlackEvent({ type: "toString" })).toEqual({ kind: "other" });
});

test("Enterprise routing distinguishes missing, empty and foreign authorization lists", () => {
  const identity = { appId: "A1", teamId: "THOME", botUserId: "UBOT", enterpriseId: "EORG" };
  const bot = {
    teamId: "THOME",
    userId: "UBOT",
    enterpriseId: "EORG",
    isBot: true,
    isEnterpriseInstall: false,
  };
  const event: EventCallback = {
    teamId: "TSIBLING",
    appId: "A1",
    authorizations: [bot],
    event: { type: "message" },
  };
  expect(isForInstallation(event, identity)).toBe(true);
  for (const authorizations of [null, [], [{ ...bot, userId: "UOTHER" }]]) {
    expect(isForInstallation({ ...event, authorizations }, identity)).toBe(false);
  }
  expect(isForInstallation({ ...event, teamId: "THOME", authorizations: null }, identity)).toBe(
    true,
  );
  expect(isForInstallation({ ...event, event: { type: "app_uninstalled" } }, identity)).toBe(false);
});

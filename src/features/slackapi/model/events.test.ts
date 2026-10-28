import { describe, expect, test } from "bun:test";
import type { Authorization, EventCallback } from "./envelopes";
import {
  handledEventTypes,
  isForInstallation,
  readSlackEvent,
  type RoutingIdentity,
} from "./events";

const installation: RoutingIdentity = {
  appId: "AAPP",
  teamId: "THOME",
  botUserId: "UBOT",
  enterpriseId: null,
};

const ourBot: Authorization = {
  enterpriseId: null,
  teamId: "THOME",
  userId: "UBOT",
  isBot: true,
  isEnterpriseInstall: false,
};

function delivery(changes: Partial<EventCallback> = {}): EventCallback {
  return {
    teamId: "THOME",
    appId: "AAPP",
    authorizations: [ourBot],
    eventId: "Ev1",
    eventTime: 1700000000,
    event: { type: "message", channel: "C1", user: "UALICE", text: "hi", ts: "1700000000.000100" },
    ...changes,
  };
}

describe("reading events", () => {
  test("a message event keeps its parsed payload for normalizing against its link", () => {
    expect(
      readSlackEvent({ type: "message", channel: "C1", user: "UALICE", ts: "1700000000.000100" }),
    ).toEqual({
      kind: "message",
      payload: {
        shape: "posted",
        channel: "C1",
        message: { type: "message", user: "UALICE", ts: "1700000000.000100" },
      },
    });
    expect(
      readSlackEvent({
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "1700000000.000100",
      }),
    ).toEqual({
      kind: "message",
      payload: { shape: "deleted", channel: "C1", deletedTs: "1700000000.000100" },
    });
  });

  test("membership events name the member and the channel", () => {
    const member = { user: "UBOT", channel: "C1", channel_type: "G", team: "THOME" };
    expect(readSlackEvent({ type: "member_joined_channel", ...member, inviter: "UALICE" })).toEqual(
      { kind: "membership", change: "joined", channelId: "C1", userId: "UBOT" },
    );
    expect(readSlackEvent({ type: "member_left_channel", ...member })).toEqual({
      kind: "membership",
      change: "left",
      channelId: "C1",
      userId: "UBOT",
    });
  });

  test("channel events name the change and the channel, which a rename nests", () => {
    const changes = [
      [{ type: "channel_archive", channel: "C1", user: "UALICE" }, "archived"],
      [{ type: "channel_deleted", channel: "C1" }, "deleted"],
      [{ type: "channel_rename", channel: { id: "C1", name: "new", created: 1 } }, "renamed"],
      [{ type: "group_rename", channel: { id: "C1", name: "new", created: 1 } }, "renamed"],
      [{ type: "channel_shared", connected_team_id: "TOTHER", channel: "C1" }, "shared"],
      [
        {
          type: "channel_unshared",
          previously_connected_team_id: "TOTHER",
          channel: "C1",
          is_ext_shared: false,
        },
        "unshared",
      ],
    ] as const;
    for (const [event, change] of changes) {
      expect(readSlackEvent(event)).toEqual({ kind: "channel", change, channelId: "C1" });
    }
  });

  test("an ID change names both IDs, and a file deletion names only the file", () => {
    expect(
      readSlackEvent({
        type: "channel_id_changed",
        old_channel_id: "G1",
        new_channel_id: "C2",
        event_ts: "1700000000.000100",
      }),
    ).toEqual({ kind: "channel_id_changed", oldChannelId: "G1", newChannelId: "C2" });
    expect(readSlackEvent({ type: "file_deleted", file_id: "F1", event_ts: "1.2" })).toEqual({
      kind: "file_deleted",
      fileId: "F1",
    });
  });

  test("an uninstall carries nothing, and a revocation names the bot users it revoked", () => {
    expect(readSlackEvent({ type: "app_uninstalled" })).toEqual({ kind: "uninstalled" });
    expect(
      readSlackEvent({ type: "tokens_revoked", tokens: { oauth: ["UALICE"], bot: ["UBOT"] } }),
    ).toEqual({ kind: "tokens_revoked", botUserIds: ["UBOT"] });
    expect(readSlackEvent({ type: "tokens_revoked", tokens: { oauth: ["UALICE"] } })).toEqual({
      kind: "tokens_revoked",
      botUserIds: [],
    });
  });

  test("a type the manifest doesn't subscribe to is passed on by name", () => {
    expect(readSlackEvent({ type: "reaction_added", user: "UALICE" })).toEqual({
      kind: "other",
      type: "reaction_added",
    });
    expect(readSlackEvent({ type: "toString" })).toEqual({ kind: "other", type: "toString" });
  });

  test("a malformed event keeps its channel for repair and never repeats its content", () => {
    expect(
      readSlackEvent({ type: "message", channel: "C1", ts: "soon", text: "the code is 4829" }),
    ).toEqual({ kind: "malformed", issues: expect.any(Array), channelId: "C1" });
    const read = readSlackEvent({ type: "message", channel: "C1", ts: "soon", text: "4829" });
    expect(JSON.stringify(read)).not.toContain("4829");
    expect(readSlackEvent({ type: "channel_rename", channel: { name: "new" } })).toEqual({
      kind: "malformed",
      issues: ["invalid_type at event.channel.id"],
      channelId: null,
    });
    expect(readSlackEvent({ type: "file_deleted" })).toEqual({
      kind: "malformed",
      issues: ["invalid_type at event.file_id"],
      channelId: null,
    });
  });

  test("the manifest's events are the ones handled", async () => {
    const manifest = await Bun.file(
      new URL("../../../../docs/manifest.yaml", import.meta.url),
    ).text();
    const subscribed = Bun.YAML.parse(manifest) as {
      settings: { event_subscriptions: { bot_events: string[] } };
    };
    const types = subscribed.settings.event_subscriptions.bot_events.map((event) =>
      event.startsWith("message.") ? "message" : event,
    );
    expect([...handledEventTypes].sort()).toEqual([...new Set(types)].sort());
  });
});

describe("routing events to our installation", () => {
  test("an event is ours when our bot is authorized, whichever workspace it happened in", () => {
    expect(isForInstallation(delivery(), installation)).toBe(true);
    expect(isForInstallation(delivery({ teamId: "TSIBLING" }), installation)).toBe(true);
  });

  test("another app's event is never ours", () => {
    expect(isForInstallation(delivery({ appId: "AOTHER" }), installation)).toBe(false);
    expect(
      isForInstallation(
        delivery({ appId: "AOTHER", event: { type: "app_uninstalled" }, authorizations: null }),
        installation,
      ),
    ).toBe(false);
  });

  test("an authorization counts only as our bot user in our workspace", () => {
    const routes = (changes: Partial<Authorization>) =>
      isForInstallation(delivery({ authorizations: [{ ...ourBot, ...changes }] }), installation);
    expect(routes({ isBot: false })).toBe(false);
    expect(routes({ userId: "UOTHERBOT" })).toBe(false);
    expect(routes({ userId: null })).toBe(false);
    expect(routes({ teamId: "TSIBLING" })).toBe(false);
    expect(routes({ teamId: null, isEnterpriseInstall: true })).toBe(false);
    expect(routes({ isEnterpriseInstall: true })).toBe(false);
    expect(routes({ enterpriseId: "EORG" })).toBe(false);
  });

  test("an Enterprise authorization must name our org, and may leave it out", () => {
    const enterprise = { ...installation, enterpriseId: "EORG" };
    const routes = (enterpriseId: string | null) =>
      isForInstallation(delivery({ authorizations: [{ ...ourBot, enterpriseId }] }), enterprise);
    expect(routes("EORG")).toBe(true);
    expect(routes(null)).toBe(true);
    expect(routes("EOTHER")).toBe(false);
  });

  test("any one authorization for our bot is enough", () => {
    const foreign = { ...ourBot, teamId: "TSIBLING", userId: "UOTHERBOT" };
    expect(isForInstallation(delivery({ authorizations: [foreign, ourBot] }), installation)).toBe(
      true,
    );
    expect(isForInstallation(delivery({ authorizations: [foreign] }), installation)).toBe(false);
  });

  test("an empty list is never a missing one, even when the workspace is ours", () => {
    expect(isForInstallation(delivery({ authorizations: [] }), installation)).toBe(false);
  });

  test("an event without authorizations goes by its workspace, only for a handled type", () => {
    const missing = (changes: Partial<EventCallback>) =>
      isForInstallation(delivery({ authorizations: null, ...changes }), installation);
    expect(missing({})).toBe(true);
    expect(missing({ event: { type: "channel_deleted", channel: "C1" } })).toBe(true);
    expect(missing({ teamId: "TSIBLING" })).toBe(false);
    expect(missing({ event: { type: "reaction_added" } })).toBe(false);
  });

  test("an uninstall or a revocation goes by its workspace, not by the bot's authorization", () => {
    const uninstall = { type: "app_uninstalled" };
    const userInstall = { ...ourBot, userId: "UALICE", isBot: false };
    expect(
      isForInstallation(
        delivery({ event: uninstall, authorizations: [userInstall] }),
        installation,
      ),
    ).toBe(true);
    expect(
      isForInstallation(
        delivery({ event: uninstall, teamId: "TSIBLING", authorizations: [ourBot] }),
        installation,
      ),
    ).toBe(false);
    const revoked = { type: "tokens_revoked", tokens: { bot: ["UBOT"] } };
    expect(
      isForInstallation(delivery({ event: revoked, authorizations: null }), installation),
    ).toBe(true);
    expect(
      isForInstallation(delivery({ event: revoked, authorizations: [userInstall] }), installation),
    ).toBe(true);
    expect(
      isForInstallation(
        delivery({ event: revoked, authorizations: null, teamId: "TSIBLING" }),
        installation,
      ),
    ).toBe(false);
  });
});

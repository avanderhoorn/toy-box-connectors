import { describe, expect, test } from "bun:test";
import { privateAudience } from "@links/model/testFixtures";
import { openRequest } from "@requests/model/lifecycle";
import type { StoredRequest } from "@requests/server/database";
import type { Installation } from "@slackapi/model/installation";
import { channelFacts } from "@slackapi/model/testFixtures";
import type { ChannelInfo } from "@slackapi/server/channels";
import { postingPermission, type PostingLink } from "./posting";

const now = 1_700_000_100_000;

type Facts = {
  post: Parameters<typeof postingPermission>[0];
  installation: Installation;
  link: PostingLink;
  request: StoredRequest;
  channel: ChannelInfo;
};

function facts(): Facts {
  return {
    post: {
      kind: "reply",
      phase: "final",
      linkId: "link",
      requestId: 14,
      requestRev: 1,
      channelId: "C-link",
      threadTs: "1700000100.000100",
    },
    installation: {
      teamId: "T-home",
      appId: "A-app",
      botId: "B-bot",
      botUserId: "U-bot",
      enterpriseId: null,
      status: "active",
    },
    link: {
      id: "link",
      status: "active",
      slackChannelId: "C-link",
      approved: privateAudience(),
      allowlist: new Set(["U-owner"]),
    },
    request: {
      ...openRequest(
        {
          linkId: "link",
          channelId: "C-link",
          rootTs: "1700000100.000100",
          sourceTs: "1700000100.000100",
          requesterUserId: "U-owner",
          reason: "mention",
          inputHash: "input",
          late: false,
        },
        now - 1_000,
      ),
      id: 14,
      state: "answering",
      servedRev: 1,
      seenAt: now - 1_000,
    },
    channel: { facts: channelFacts(), refreshedAt: now, invalidatedAt: null },
  };
}

function check(value: Facts) {
  return postingPermission(
    value.post,
    value.installation,
    value.link,
    value.request,
    value.channel,
    now,
  );
}

describe("send-time posting authority", () => {
  test("a requester needs their exact ID allowed", () => {
    const value = facts();
    expect(check(value)).toEqual({ kind: "allowed" });
    value.request.requesterUserId = "U-carol";
    expect(check(value)).toEqual({ kind: "failed", error: "requester_denied" });
    value.link.allowlist = new Set(["U-carol"]);
    expect(check(value)).toEqual({ kind: "allowed" });
    value.link.allowlist = new Set(["W-carol"]);
    expect(check(value)).toEqual({ kind: "failed", error: "requester_denied" });
  });

  test.each(["auth_failed", "uninstalled"] as const)(
    "an installation that's %s holds output",
    (status) => {
      const value = facts();
      value.installation.status = status;
      expect(check(value)).toEqual({ kind: "waiting", reason: "installation_inactive" });
    },
  );

  test("an absent installation holds output", () => {
    const value = facts();
    expect(
      postingPermission(value.post, null, value.link, value.request, value.channel, now),
    ).toEqual({ kind: "waiting", reason: "installation_inactive" });
  });

  test.each(["paused", "suspended"] as const)("a link that's %s holds output", (status) => {
    const value = facts();
    value.link.status = status;
    expect(check(value)).toEqual({ kind: "waiting", reason: "link_inactive" });
  });

  test("a removed or replaced link cannot authorize the old item's output", () => {
    const value = facts();
    expect(
      postingPermission(value.post, value.installation, null, value.request, value.channel, now),
    ).toEqual({ kind: "failed", error: "link_removed" });
    value.link.id = "replacement";
    expect(check(value)).toEqual({ kind: "failed", error: "link_removed" });
  });

  test.each([{ channelId: "C-other" }, { threadTs: null }, { threadTs: "1700000101.000100" }])(
    "a reply must stay in the exact request thread: %j",
    (change) => {
      const value = facts();
      Object.assign(value.post, change);
      expect(check(value)).toEqual({ kind: "failed", error: "destination_changed" });
    },
  );

  test("a reply cannot use a request from another channel or link", () => {
    const value = facts();
    value.request.channelId = "C-other";
    expect(check(value)).toEqual({ kind: "failed", error: "destination_changed" });
    value.request.channelId = "C-link";
    value.request.linkId = "other-link";
    expect(check(value)).toEqual({ kind: "failed", error: "request_missing" });
  });

  test("a reply cannot follow its request to a channel the link doesn't watch", () => {
    const value = facts();
    value.post.channelId = "C-moved";
    value.request.channelId = "C-moved";
    expect(check(value)).toEqual({ kind: "failed", error: "destination_changed" });
  });

  test("a missing or different request cannot authorize a reply", () => {
    const value = facts();
    expect(
      postingPermission(value.post, value.installation, value.link, null, value.channel, now),
    ).toEqual({ kind: "failed", error: "request_missing" });
    value.request.id = 15;
    expect(check(value)).toEqual({ kind: "failed", error: "request_missing" });
  });

  test("a stale queued answer is superseded even while its source awaits verification", () => {
    const value = facts();
    value.request.inputRev = 2;
    value.request.sourceUnverifiedAt = now;
    expect(check(value)).toEqual({ kind: "superseded", revision: 2 });
  });

  test("an unverified source holds output before requesting another channel read", () => {
    const value = facts();
    value.request.sourceUnverifiedAt = now;
    value.channel.refreshedAt = 0;
    expect(check(value)).toEqual({ kind: "waiting", reason: "source_unverified" });
  });

  test.each(["answered", "dismissed", "expired"] as const)(
    "only an explicit follow-up may post to a request that's %s",
    (state) => {
      const value = facts();
      value.request.state = state;
      expect(check(value)).toEqual({ kind: "failed", error: "request_not_ready" });
      value.post.phase = "follow_up";
      expect(check(value)).toEqual({ kind: "allowed" });
    },
  );

  test.each(["open", "seen", "in_progress", "answering"] as const)(
    "a follow-up cannot post to a request that's still %s",
    (state) => {
      const value = facts();
      value.request.state = state;
      value.post.phase = "follow_up";
      expect(check(value)).toEqual({ kind: "failed", error: "request_not_ready" });
    },
  );

  test("a cancelled request cannot receive even an explicit follow-up", () => {
    const value = facts();
    value.request.state = "cancelled";
    value.post.phase = "follow_up";
    expect(check(value)).toEqual({ kind: "failed", error: "request_closed" });
  });

  test("progress may post while seen or in progress, never after a final was queued", () => {
    const value = facts();
    value.post.kind = "progress";
    value.post.phase = null;
    expect(check(value)).toEqual({ kind: "failed", error: "request_not_ready" });
    value.request.state = "seen";
    expect(check(value)).toEqual({ kind: "allowed" });
    value.request.state = "in_progress";
    expect(check(value)).toEqual({ kind: "allowed" });
  });

  test("publications go to the watched channel's root, not a request", () => {
    const value = facts();
    value.post = {
      ...value.post,
      kind: "publication",
      phase: null,
      requestId: null,
      requestRev: null,
      threadTs: null,
    };
    expect(
      postingPermission(value.post, value.installation, value.link, null, value.channel, now),
    ).toEqual({ kind: "allowed" });
    value.post.threadTs = "1700000100.000100";
    expect(check(value)).toEqual({ kind: "failed", error: "destination_changed" });
    value.post.threadTs = null;
    value.post.channelId = "C-elsewhere";
    expect(check(value)).toEqual({ kind: "failed", error: "destination_changed" });
  });

  test("feedback cannot accidentally use the lead-post gate", () => {
    const value = facts();
    value.post.kind = "reaction";
    expect(check(value)).toEqual({ kind: "failed", error: "invalid_post" });
  });
});

describe("freshness and the owner-approved audience", () => {
  test("119,999 ms is fresh and 120,000 ms needs another read", () => {
    const value = facts();
    value.channel.refreshedAt = now - 119_999;
    expect(check(value)).toEqual({ kind: "allowed" });
    value.channel.refreshedAt = now - 120_000;
    expect(check(value)).toEqual({ kind: "refresh", channelId: "C-link" });
  });

  test("a signal at the same moment as the read still invalidates it", () => {
    const value = facts();
    value.channel.invalidatedAt = now;
    expect(check(value)).toEqual({ kind: "refresh", channelId: "C-link" });
  });

  test("a missing, future-dated or wrong channel read cannot authorize a post", () => {
    const value = facts();
    expect(
      postingPermission(value.post, value.installation, value.link, value.request, null, now),
    ).toEqual({ kind: "refresh", channelId: "C-link" });
    value.channel.refreshedAt = now + 1;
    expect(check(value)).toEqual({ kind: "refresh", channelId: "C-link" });
    value.channel.refreshedAt = now;
    value.channel.facts.id = "C-other";
    expect(check(value)).toEqual({ kind: "refresh", channelId: "C-link" });
  });

  test.each([
    [{ kind: "public" }, "channel_made_public"],
    [{ isArchived: true }, "channel_archived"],
    [{ isMember: false }, "bot_removed"],
    [{ isExtShared: true }, "channel_external"],
    [{ isPendingExtShared: true }, "channel_external"],
    [{ sharedTeamIds: ["T-home", "T-other"] }, "workspace_joined"],
    [{ isOrgShared: true, sharedTeamIds: [] }, "workspaces_unknown"],
  ] as const)("an unapproved or unknown audience cannot authorize output: %j", (change, reason) => {
    const value = facts();
    Object.assign(value.channel.facts, change);
    expect(check(value)).toEqual({ kind: "suspended", reason });
  });
});

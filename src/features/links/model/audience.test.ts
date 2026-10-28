import { describe, expect, test } from "bun:test";
import { channelFacts } from "@slackapi/model/testFixtures";
import {
  audienceOf,
  audienceProblem,
  judgeChannel,
  judgeLinkChannel,
  signalSuspends,
  widening,
  type Audience,
  type ChannelSuspendReason,
} from "./audience";

const home = { teamId: "T-home", enterpriseId: null };
const orgHome = { teamId: "T-home", enterpriseId: "E-org" };

function audience(changes: Partial<Audience> = {}): Audience {
  return {
    channelId: "C-link",
    kind: "private",
    external: false,
    orgShared: false,
    enterpriseId: null,
    workspaces: ["T-home"],
    ...changes,
  };
}

describe("a channel's audience", () => {
  test("is its kind, its sharing and the workspaces it's in", () => {
    expect(audienceOf(channelFacts(), home)).toEqual(audience());
    expect(
      audienceOf(
        channelFacts({
          kind: "public",
          isOrgShared: true,
          enterpriseId: "E-org",
          sharedTeamIds: ["T-home", "T-sibling"],
        }),
        orgHome,
      ),
    ).toEqual(
      audience({
        kind: "public",
        orgShared: true,
        enterpriseId: "E-org",
        workspaces: ["T-home", "T-sibling"],
      }),
    );
  });

  test("a share with another organization counts as external while it's still pending", () => {
    expect(audienceOf(channelFacts({ isExtShared: true }), home)?.external).toBe(true);
    expect(audienceOf(channelFacts({ isPendingExtShared: true }), home)?.external).toBe(true);
  });

  test("a channel shared with no one is in the workspace Slack names, or else the installation's", () => {
    const unlisted = channelFacts({ sharedTeamIds: [], contextTeamId: null });
    expect(audienceOf({ ...unlisted, contextTeamId: "T-other" }, home)?.workspaces).toEqual([
      "T-other",
    ]);
    expect(audienceOf(unlisted, home)?.workspaces).toEqual(["T-home"]);
    expect(audienceOf(unlisted, { teamId: "T-elsewhere" })?.workspaces).toEqual(["T-elsewhere"]);
  });

  test("a shared channel Slack lists no workspaces for has an unknown audience", () => {
    const unlisted = channelFacts({ sharedTeamIds: [], contextTeamId: null });
    expect(
      audienceOf({ ...unlisted, isOrgShared: true, enterpriseId: "E-org" }, orgHome)?.workspaces,
    ).toEqual([]);
    expect(audienceOf({ ...unlisted, isExtShared: true }, home)?.workspaces).toEqual([]);
    expect(audienceOf({ ...unlisted, isPendingExtShared: true }, home)?.workspaces).toEqual([]);
  });

  test("a direct message has no audience a link could use", () => {
    expect(audienceOf(channelFacts({ kind: "im" }), home)).toBeNull();
    expect(audienceOf(channelFacts({ kind: "mpim" }), home)).toBeNull();
  });
});

describe("which audiences a link can have", () => {
  test("a channel in the installation's workspace alone, public or private, can be linked", () => {
    expect(audienceProblem(audience(), home)).toBeNull();
    expect(audienceProblem(audience({ kind: "public" }), home)).toBeNull();
  });

  test("Slack Connect is refused, shared or pending", () => {
    expect(audienceProblem(audience({ external: true }), home)).toBe("channel_external");
    expect(audienceProblem(audience({ external: true, orgShared: true }), orgHome)).toBe(
      "channel_external",
    );
  });

  test("an org-shared channel can be linked only inside the installation's own org", () => {
    const orgShared = audience({
      orgShared: true,
      enterpriseId: "E-org",
      workspaces: ["T-home", "T-sibling"],
    });
    expect(audienceProblem(orgShared, orgHome)).toBeNull();
    expect(audienceProblem(orgShared, home)).toBe("channel_other_org");
    expect(audienceProblem(orgShared, { ...orgHome, enterpriseId: "E-other" })).toBe(
      "channel_other_org",
    );
    expect(audienceProblem({ ...orgShared, enterpriseId: null }, orgHome)).toBe(
      "channel_other_org",
    );
  });

  test("a channel whose workspaces Slack didn't list is refused rather than guessed", () => {
    expect(
      audienceProblem(
        audience({ orgShared: true, enterpriseId: "E-org", workspaces: [] }),
        orgHome,
      ),
    ).toBe("workspaces_unknown");
    expect(audienceProblem(audience({ workspaces: [] }), home)).toBe("workspaces_unknown");
  });

  test("a channel outside the installation's workspace is refused", () => {
    expect(audienceProblem(audience({ workspaces: ["T-other"] }), home)).toBe(
      "channel_other_workspace",
    );
    expect(audienceProblem(audience({ workspaces: ["T-home", "T-other"] }), home)).toBe(
      "channel_other_workspace",
    );
    expect(
      audienceProblem(
        audience({ orgShared: true, enterpriseId: "E-org", workspaces: ["T-sibling"] }),
        orgHome,
      ),
    ).toBe("channel_other_workspace");
  });
});

describe("widening the approved audience", () => {
  test("the same audience, or a narrower one, isn't wider", () => {
    expect(widening(audience(), audience())).toBeNull();
    expect(widening(audience({ kind: "public" }), audience())).toBeNull();
    const twoWorkspaces = audience({
      orgShared: true,
      enterpriseId: "E-org",
      workspaces: ["T-home", "T-sibling"],
    });
    expect(
      widening(twoWorkspaces, audience({ ...twoWorkspaces, workspaces: ["T-home"] })),
    ).toBeNull();
  });

  test("an external share, even a pending one, is wider whatever was approved", () => {
    expect(widening(audience(), audience({ external: true }))).toBe("channel_external");
    expect(widening(audience({ external: true }), audience({ external: true }))).toBe(
      "channel_external",
    );
  });

  test("a private channel made public is wider", () => {
    expect(widening(audience(), audience({ kind: "public" }))).toBe("channel_made_public");
  });

  test("a workspace the approved set lacks is wider, even when another one left", () => {
    expect(
      widening(
        audience(),
        audience({ orgShared: true, enterpriseId: "E-org", workspaces: ["T-home", "T-sibling"] }),
      ),
    ).toBe("workspace_joined");
    expect(
      widening(
        audience({ orgShared: true, enterpriseId: "E-org", workspaces: ["T-home", "T-a"] }),
        audience({ orgShared: true, enterpriseId: "E-org", workspaces: ["T-home", "T-b"] }),
      ),
    ).toBe("workspace_joined");
  });
});

describe("judging a fresh read of a linked channel", () => {
  const approved = audience();

  test("a channel whose audience is no wider than approved keeps its link", () => {
    expect(judgeChannel(approved, channelFacts(), home)).toEqual({ kind: "approved" });
    expect(
      judgeChannel(approved, channelFacts({ name: "renamed", sharedTeamIds: [] }), home),
    ).toEqual({ kind: "approved" });
    expect(judgeChannel(audience({ kind: "public" }), channelFacts(), home)).toEqual({
      kind: "approved",
    });
  });

  test("a read of a channel shared with no one that names no workspace keeps its link", () => {
    expect(
      judgeChannel(approved, channelFacts({ sharedTeamIds: [], contextTeamId: null }), home),
    ).toEqual({ kind: "approved" });
  });

  test("a channel Slack can't find, an archived one and one without the bot suspend it", () => {
    expect(judgeChannel(approved, null, home)).toEqual({
      kind: "suspended",
      reason: "channel_not_found",
    });
    expect(judgeChannel(approved, channelFacts({ isArchived: true }), home)).toEqual({
      kind: "suspended",
      reason: "channel_archived",
    });
    expect(judgeChannel(approved, channelFacts({ isMember: false }), home)).toEqual({
      kind: "suspended",
      reason: "bot_removed",
    });
  });

  test("each widening suspends it", () => {
    expect(judgeChannel(approved, channelFacts({ isPendingExtShared: true }), home)).toEqual({
      kind: "suspended",
      reason: "channel_external",
    });
    expect(judgeChannel(approved, channelFacts({ kind: "public" }), home)).toEqual({
      kind: "suspended",
      reason: "channel_made_public",
    });
    expect(
      judgeChannel(
        approved,
        channelFacts({
          isOrgShared: true,
          enterpriseId: "E-org",
          sharedTeamIds: ["T-home", "T-sibling"],
        }),
        orgHome,
      ),
    ).toEqual({ kind: "suspended", reason: "workspace_joined" });
  });

  test("a read that doesn't say which workspaces can read it holds posts without suspending", () => {
    expect(
      judgeChannel(
        audience({ orgShared: true, enterpriseId: "E-org", workspaces: ["T-home", "T-sibling"] }),
        channelFacts({ isOrgShared: true, enterpriseId: "E-org", sharedTeamIds: [] }),
        orgHome,
      ),
    ).toEqual({ kind: "held", reason: "workspaces_unknown" });
  });
});

describe("judging a read for a link that uses the channel", () => {
  const watched = { monitored: true, publish: false };
  const publishedTo = { monitored: false, publish: true };
  const both = { monitored: true, publish: true };
  const privateWatchedPublicPublish = {
    monitored: audience(),
    publish: audience({ kind: "public" }),
  };

  test("each role is judged against the audience the owner approved for it", () => {
    const madePublic = channelFacts({ kind: "public" });
    expect(judgeLinkChannel(privateWatchedPublicPublish, watched, madePublic, home)).toEqual({
      kind: "suspended",
      reason: "channel_made_public",
    });
    expect(judgeLinkChannel(privateWatchedPublicPublish, publishedTo, madePublic, home)).toEqual({
      kind: "approved",
    });
  });

  test("a channel used in both roles is suspended when either role would be", () => {
    expect(
      judgeLinkChannel(privateWatchedPublicPublish, both, channelFacts({ kind: "public" }), home),
    ).toEqual({ kind: "suspended", reason: "channel_made_public" });
    const orgShared = audience({
      orgShared: true,
      enterpriseId: "E-org",
      workspaces: ["T-home", "T-sibling"],
    });
    expect(
      judgeLinkChannel(
        { monitored: { ...orgShared, kind: "public" }, publish: orgShared },
        both,
        channelFacts({
          kind: "public",
          isOrgShared: true,
          enterpriseId: "E-org",
          sharedTeamIds: [],
        }),
        orgHome,
      ),
    ).toEqual({ kind: "suspended", reason: "channel_made_public" });
  });

  test("a hold in either role holds a link that isn't suspended", () => {
    const orgShared = audience({
      orgShared: true,
      enterpriseId: "E-org",
      workspaces: ["T-home", "T-sibling"],
    });
    expect(
      judgeLinkChannel(
        { monitored: orgShared, publish: orgShared },
        both,
        channelFacts({ isOrgShared: true, enterpriseId: "E-org", sharedTeamIds: [] }),
        orgHome,
      ),
    ).toEqual({ kind: "held", reason: "workspaces_unknown" });
  });

  test("a channel Slack can't find suspends every link that uses it", () => {
    expect(judgeLinkChannel(privateWatchedPublicPublish, publishedTo, null, home)).toEqual({
      kind: "suspended",
      reason: "channel_not_found",
    });
  });
});

describe("whether a lifecycle signal suspends a link", () => {
  const publicEverywhere = {
    monitored: audience({ kind: "public" }),
    publish: audience({ kind: "public" }),
  };

  test("every signal but a channel made public suspends, whatever was approved", () => {
    const reasons: ChannelSuspendReason[] = [
      "channel_not_found",
      "channel_archived",
      "bot_removed",
      "channel_restricted",
      "channel_external",
      "workspace_joined",
    ];
    for (const reason of reasons) {
      expect(signalSuspends(publicEverywhere, { monitored: true, publish: false }, reason)).toBe(
        true,
      );
      expect(signalSuspends(publicEverywhere, { monitored: false, publish: true }, reason)).toBe(
        true,
      );
    }
  });

  test("a channel made public suspends a link only where the owner approved it private", () => {
    const privateWatched = { monitored: audience(), publish: audience({ kind: "public" }) };
    expect(
      signalSuspends(privateWatched, { monitored: true, publish: false }, "channel_made_public"),
    ).toBe(true);
    expect(
      signalSuspends(privateWatched, { monitored: false, publish: true }, "channel_made_public"),
    ).toBe(false);
    expect(
      signalSuspends(privateWatched, { monitored: true, publish: true }, "channel_made_public"),
    ).toBe(true);
    expect(
      signalSuspends(publicEverywhere, { monitored: true, publish: true }, "channel_made_public"),
    ).toBe(false);
  });
});

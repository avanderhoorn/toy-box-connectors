import { describe, expect, test } from "bun:test";
import type { ChannelFacts } from "@slackapi/model/channels";
import { channelFacts } from "@slackapi/model/testFixtures";
import {
  approvableAudience,
  audienceOf,
  audienceProblem,
  judgeChannel,
  type Audience,
} from "./audience";
import { privateAudience } from "./testFixtures";

const home = { teamId: "T-home", enterpriseId: null };
const orgHome = { teamId: "T-home", enterpriseId: "E-org" };
const unlisted = { sharedTeamIds: [], contextTeamId: null };
const orgShared = {
  orgShared: true,
  enterpriseId: "E-org",
  workspaces: ["T-home", "T-sibling"],
} as const;

function audience(changes: Partial<Audience> = {}): Audience {
  return { ...privateAudience(), ...changes };
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
          sharedTeamIds: orgShared.workspaces,
        }),
        orgHome,
      ),
    ).toEqual(audience({ kind: "public", ...orgShared }));
    expect(audienceOf(channelFacts({ isPendingExtShared: true }), home)?.external).toBe(true);
    expect(audienceOf(channelFacts({ kind: "im" }), home)).toBeNull();
  });

  test.each([
    ["the workspace Slack names", { contextTeamId: "T-other" }, ["T-other"]],
    ["the installation's when Slack names none", {}, ["T-home"]],
    ["unknown when it's shared across the org", { isOrgShared: true }, []],
    ["unknown when it's shared outside the org", { isExtShared: true }, []],
  ] as const)("an unlisted channel's workspaces are %s", (_, changes, workspaces) => {
    expect(audienceOf(channelFacts({ ...unlisted, ...changes }), home)?.workspaces).toEqual(
      workspaces,
    );
  });
});

describe("which audiences a link can have", () => {
  test.each([
    ["a private channel in the installation's workspace", audience(), home],
    ["a public one", audience({ kind: "public" }), home],
    ["one shared across the installation's org", audience(orgShared), orgHome],
  ] as const)("%s can be linked", (_, candidate, installation) => {
    expect(audienceProblem(candidate, installation)).toBeNull();
  });

  test.each([
    ["Slack Connect", "channel_external", audience({ external: true }), home],
    [
      "one shared across another org",
      "channel_other_org",
      audience(orgShared),
      { ...orgHome, enterpriseId: "E-other" },
    ],
    [
      "one whose workspaces Slack didn't list",
      "workspaces_unknown",
      audience({ ...orgShared, workspaces: [] }),
      orgHome,
    ],
    [
      "one in another workspace",
      "channel_other_workspace",
      audience({ workspaces: ["T-other"] }),
      home,
    ],
    [
      "one in another workspace as well, without being shared across an org",
      "channel_other_workspace",
      audience({ workspaces: ["T-home", "T-other"] }),
      home,
    ],
  ] as const)("%s is refused as %s", (_, problem, candidate, installation) => {
    expect(audienceProblem(candidate, installation)).toBe(problem);
  });
});

describe("judging a fresh read of a linked channel", () => {
  const orgFacts = { isOrgShared: true, enterpriseId: "E-org" };

  test.each([
    ["the audience the owner approved", audience(), channelFacts()],
    [
      "a renamed channel Slack names no workspace for",
      audience(),
      channelFacts({ ...unlisted, name: "renamed" }),
    ],
    ["a public channel made private", audience({ kind: "public" }), channelFacts()],
    [
      "a workspace leaving",
      audience(orgShared),
      channelFacts({ ...orgFacts, sharedTeamIds: ["T-home"] }),
    ],
  ] as const)("%s keeps the link", (_, approved, facts) => {
    expect(judgeChannel(approved, facts, home)).toEqual({ kind: "approved" });
  });

  test.each([
    ["a channel Slack can't find", "channel_not_found", audience(), null],
    ["an archived channel", "channel_archived", audience(), channelFacts({ isArchived: true })],
    ["one without the bot", "bot_removed", audience(), channelFacts({ isMember: false })],
    [
      "a pending share outside the org",
      "channel_external",
      audience(),
      channelFacts({ isPendingExtShared: true }),
    ],
    [
      "a private channel made public",
      "channel_made_public",
      audience(),
      channelFacts({ kind: "public" }),
    ],
    [
      "a workspace joining",
      "workspace_joined",
      audience(),
      channelFacts({ ...orgFacts, sharedTeamIds: orgShared.workspaces }),
    ],
    [
      "one workspace swapped for another",
      "workspace_joined",
      audience({ ...orgShared, workspaces: ["T-home", "T-a"] }),
      channelFacts({ ...orgFacts, sharedTeamIds: ["T-home", "T-b"] }),
    ],
    [
      "a read that doesn't list the workspaces",
      "workspaces_unknown",
      audience(orgShared),
      channelFacts({ ...orgFacts, sharedTeamIds: [] }),
    ],
  ] as const)("%s suspends the link as %s", (_, reason, approved, facts: ChannelFacts | null) => {
    expect(judgeChannel(approved, facts, home)).toEqual({ kind: "suspended", reason });
  });
});

describe("linking a channel or resuming its link", () => {
  test("approves its audience as Slack describes it now", () => {
    expect(approvableAudience(channelFacts({ kind: "public" }), home)).toEqual(
      audience({ kind: "public" }),
    );
  });

  test.each([
    ["a channel Slack can't find", "channel_not_found", null],
    ["a direct message", "not_a_channel", channelFacts({ kind: "im" })],
    ["a group direct message", "not_a_channel", channelFacts({ kind: "mpim" })],
    ["an archived channel", "channel_archived", channelFacts({ isArchived: true })],
    ["a channel without the bot", "bot_removed", channelFacts({ isMember: false })],
    ["Slack Connect", "channel_external", channelFacts({ isExtShared: true })],
    [
      "another workspace's channel",
      "channel_other_workspace",
      channelFacts({ contextTeamId: "T-b", sharedTeamIds: ["T-b"] }),
    ],
  ] as const)("refuses %s as %s", (_, problem, facts: ChannelFacts | null) => {
    expect(approvableAudience(facts, home)).toBe(problem);
  });
});

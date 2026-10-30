import { describe, expect, test } from "bun:test";
import type { ChannelFacts } from "@slackapi/model/channels";
import { channelFacts as facts } from "@slackapi/model/testFixtures";
import { approvableAudience, judgeChannel, type Audience } from "./audience";
import { privateAudience } from "./testFixtures";

const home = { teamId: "T-home", enterpriseId: "E-org" };
const org = { isOrgShared: true, enterpriseId: "E-org" };
const unlisted = { sharedTeamIds: [], contextTeamId: null };
const approved = privateAudience();
const orgAudience: Audience = {
  ...approved,
  orgShared: true,
  enterpriseId: "E-org",
  workspaces: ["T-home", "T-b"],
};

/** A channel shared across the installation's org, in the workspaces `sharedTeamIds` names. */
function orgShared(...sharedTeamIds: string[]): Partial<ChannelFacts> {
  return { ...org, sharedTeamIds };
}

describe("linking a channel or resuming its link", () => {
  test("approves its audience as Slack describes it now", () => {
    const channel = facts({ ...orgShared("T-home", "T-b"), kind: "public" });
    expect(approvableAudience(channel, home)).toEqual({ ...orgAudience, kind: "public" });
  });

  test.each([
    ["a direct message", "not_a_channel", { kind: "im" }],
    ["an archived channel", "channel_archived", { isArchived: true }],
    ["a channel without the bot", "bot_removed", { isMember: false }],
    ["Slack Connect", "channel_external", { isExtShared: true }],
    ["one shared across another org", "channel_other_org", { ...org, enterpriseId: "E-c" }],
    ["one Slack lists no workspaces for", "workspaces_unknown", orgShared()],
    ["one in another workspace", "channel_other_workspace", { ...unlisted, contextTeamId: "T-b" }],
    ["one in two workspaces", "channel_other_workspace", { sharedTeamIds: ["T-home", "T-b"] }],
  ] as const)("refuses %s as %s", (_, problem, changes: Partial<ChannelFacts>) => {
    expect(approvableAudience(facts(changes), home)).toBe(problem);
  });
});

describe("judging a fresh read of a linked channel", () => {
  test.each([
    ["a public channel made private", { ...approved, kind: "public" }, {}],
    ["a public channel still public", { ...approved, kind: "public" }, { kind: "public" }],
    ["a read naming no workspace for a channel shared with none", approved, unlisted],
  ] as const)("%s keeps the link", (_, audience, changes: Partial<ChannelFacts>) => {
    expect(judgeChannel(audience, facts(changes), home)).toEqual({ kind: "approved" });
  });

  test.each([
    ["a channel Slack can't find", "channel_not_found", approved, null],
    ["an archived channel", "channel_archived", approved, { isArchived: true }],
    ["one without the bot", "bot_removed", approved, { isMember: false }],
    ["a pending Slack Connect share", "channel_external", approved, { isPendingExtShared: true }],
    ["a swapped workspace", "workspace_joined", orgAudience, orgShared("T-home", "T-c")],
    ["a read that lists no workspaces", "workspaces_unknown", orgAudience, orgShared()],
  ] as const)("%s suspends the link as %s", (_, reason, audience, changes) => {
    const verdict = judgeChannel(audience, changes && facts(changes), home);
    expect(verdict).toEqual({ kind: "suspended", reason });
  });
});

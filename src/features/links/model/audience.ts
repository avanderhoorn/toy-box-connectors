import type { ChannelFacts } from "@slackapi/model/channels";
import type { Installation } from "@slackapi/model/installation";

// A channel's audience.
//
// Who can read what the lead says in Slack is part of what the owner approves. A linked channel
// must be a public or private channel with the bot in it, shared with no other organization, and
// org-shared only inside the installation's own Enterprise org, with its workspaces listed.
// Linking or resuming keeps the channel's audience on the link as the owner approved it. Every
// later read is judged against that, never against the read before it, so a refresh nobody
// compared can't absorb a widening. Narrowing never needs the owner.

/** Who can read a channel, as the owner approves it and a link keeps it. */
export type Audience = {
  kind: "public" | "private";
  /** Shared with another organization, or an invitation to share it that way is pending. */
  external: boolean;
  /** Shared with other workspaces in its Enterprise org. */
  orgShared: boolean;
  enterpriseId: string | null;
  /**
   * The workspaces it's in, sorted. Empty when Slack lists none for a channel that's shared, since
   * one shared with no one is in the installation's workspace unless Slack names another.
   */
  workspaces: readonly string[];
};

/** Why a channel's audience isn't one a link can have. */
export type AudienceProblem =
  /** Shared with another organization, or a share with one is pending. */
  | "channel_external"
  /** Shared across an Enterprise org that isn't the installation's. */
  | "channel_other_org"
  /** In a workspace other than the installation's, without being org-shared inside its org. */
  | "channel_other_workspace"
  /** Slack didn't say which workspaces it's in. */
  | "workspaces_unknown";

/** How a channel's audience grew past the one the owner approved. */
export type Widening =
  /** Shared with another organization, or a share with one is pending. */
  | "channel_external"
  /** It was private when the owner approved it, and now it's public. */
  | "channel_made_public"
  /** A workspace the owner didn't approve can read it. */
  | "workspace_joined";

/** Why a linked channel can't be used until the owner resumes the link. */
export type ChannelSuspendReason =
  /** Slack can't find it: it was deleted, or it's private and the bot was removed. */
  | "channel_not_found"
  | "channel_archived"
  | "bot_removed"
  /** An admin policy refuses the bot's posts there, which no read of the channel shows. */
  | "channel_restricted"
  /** Slack didn't say which workspaces it's in, so nothing shows it didn't widen. */
  | "workspaces_unknown"
  | Widening;

/** What a fresh read of a linked channel means for its link. */
export type ChannelVerdict =
  | { kind: "approved" }
  | { kind: "suspended"; reason: ChannelSuspendReason };

/** A channel's audience, or null for a conversation that isn't a channel, such as a direct message. */
export function audienceOf(
  facts: ChannelFacts,
  home: Pick<Installation, "teamId">,
): Audience | null {
  if (facts.kind !== "public" && facts.kind !== "private") return null;
  return {
    kind: facts.kind,
    external: facts.isExtShared || facts.isPendingExtShared,
    orgShared: facts.isOrgShared,
    enterpriseId: facts.enterpriseId,
    workspaces: workspacesOf(facts, home),
  };
}

/**
 * Why a link can't have a channel with this audience, or null. Slack Connect is refused, and an
 * org-shared channel is allowed only inside the installation's org, with the installation's
 * workspace among those Slack lists.
 */
export function audienceProblem(
  audience: Audience,
  home: Pick<Installation, "teamId" | "enterpriseId">,
): AudienceProblem | null {
  if (audience.external) return "channel_external";
  if (audience.workspaces.length === 0) return "workspaces_unknown";
  if (
    audience.orgShared &&
    (home.enterpriseId === null || audience.enterpriseId !== home.enterpriseId)
  ) {
    return "channel_other_org";
  }
  if (!audience.workspaces.includes(home.teamId)) return "channel_other_workspace";
  if (!audience.orgShared && audience.workspaces.length > 1) return "channel_other_workspace";
  return null;
}

/**
 * How a channel's audience now is wider than the one the owner approved, or null: shared with
 * another organization or about to be, private made public, or a workspace the approved set lacks.
 */
export function widening(approved: Audience, current: Audience): Widening | null {
  if (current.external) return "channel_external";
  if (approved.kind === "private" && current.kind === "public") return "channel_made_public";
  if (current.workspaces.some((team) => !approved.workspaces.includes(team))) {
    return "workspace_joined";
  }
  return null;
}

/**
 * Judges a fresh read of a linked channel against the audience the owner approved for it. `facts`
 * is null when Slack can't find the channel.
 */
export function judgeChannel(
  approved: Audience,
  facts: ChannelFacts | null,
  home: Pick<Installation, "teamId">,
): ChannelVerdict {
  if (!facts) return suspended("channel_not_found");
  if (facts.isArchived) return suspended("channel_archived");
  if (!facts.isMember) return suspended("bot_removed");
  const current = audienceOf(facts, home);
  if (!current) return suspended("channel_not_found");
  const wider = widening(approved, current);
  if (wider) return suspended(wider);
  if (current.workspaces.length === 0) return suspended("workspaces_unknown");
  return { kind: "approved" };
}

function workspacesOf(facts: ChannelFacts, home: Pick<Installation, "teamId">): readonly string[] {
  if (facts.isOrgShared || facts.sharedTeamIds.length > 0) return facts.sharedTeamIds;
  if (facts.contextTeamId !== null) return [facts.contextTeamId];
  // The bot can only be in its own workspace's channels and ones shared into it, and v1 refuses
  // org-wide installs, so a channel shared with no one is in the installation's workspace.
  return facts.isExtShared || facts.isPendingExtShared ? [] : [home.teamId];
}

function suspended(reason: ChannelSuspendReason): ChannelVerdict {
  return { kind: "suspended", reason };
}

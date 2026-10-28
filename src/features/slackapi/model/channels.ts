import { z } from "zod";

// Channels as conversations.info describes them.
//
// The bridge keeps only what decides who can read a channel: its kind, whether it's archived,
// whether our bot is in it, the three flags that say it's shared beyond the workspace, and the org
// and workspaces it's in. Slack adds fields without notice, so unknown keys are dropped. A
// conversation that leaves out an archive or sharing flag is refused rather than assumed unshared,
// and one that leaves out whether it's private reads as public, the wider audience. One that
// leaves out its workspaces lists none, which says nothing about who can read it.

export type ChannelKind = "public" | "private" | "im" | "mpim";

/** What decides a channel's audience, as conversations.info described it. */
export type ChannelFacts = {
  id: string;
  name: string | null;
  kind: ChannelKind;
  isMember: boolean;
  isArchived: boolean;
  isExtShared: boolean;
  isPendingExtShared: boolean;
  isOrgShared: boolean;
  /** The Enterprise org it belongs to, or null outside one. */
  enterpriseId: string | null;
  /** The workspace it's in, or null when Slack didn't say. */
  contextTeamId: string | null;
  /** The workspaces it's shared with, sorted. Empty when Slack didn't list them. */
  sharedTeamIds: readonly string[];
};

/** A conversation object from conversations.info, read into the facts the bridge keeps. */
export const slackConversationSchema = z
  .object({
    id: z.string().min(1).describe("The channel's ID"),
    name: z.string().nullish().describe("The channel's name, absent for a direct message"),
    is_im: z.boolean().nullish().describe("A direct message with one person"),
    is_mpim: z.boolean().nullish().describe("A direct message with several people"),
    is_private: z.boolean().nullish().describe("Only its members can read it"),
    is_member: z.boolean().nullish().describe("Our bot is in it"),
    is_archived: z.boolean().describe("It's archived, so nothing can be posted to it"),
    is_ext_shared: z.boolean().describe("It's shared with another organization"),
    is_pending_ext_shared: z.boolean().describe("An invitation to share it externally is pending"),
    is_org_shared: z.boolean().describe("It's shared with other workspaces in an Enterprise org"),
    enterprise_id: z.string().min(1).nullish().describe("The Enterprise org it belongs to"),
    context_team_id: z.string().min(1).nullish().describe("The workspace it's in"),
    shared_team_ids: z
      .array(z.string().min(1))
      .nullish()
      .describe("The workspaces it's shared with, its own included"),
  })
  .describe("A Slack conversation")
  .transform((conversation): ChannelFacts => ({
    id: conversation.id,
    name: conversation.name ?? null,
    kind: channelKind(conversation),
    isMember: conversation.is_member ?? false,
    isArchived: conversation.is_archived,
    isExtShared: conversation.is_ext_shared,
    isPendingExtShared: conversation.is_pending_ext_shared,
    isOrgShared: conversation.is_org_shared,
    enterpriseId: conversation.enterprise_id ?? null,
    contextTeamId: conversation.context_team_id ?? null,
    sharedTeamIds: [...new Set(conversation.shared_team_ids ?? [])].sort(),
  }));

/** One page of the people in a channel, as conversations.members lists them. */
export type ChannelMembersPage = {
  members: readonly string[];
  /** The cursor that asks for the next page, or null after the last. */
  nextCursor: string | null;
};

/**
 * A page of conversations.members. Slack may return fewer people than asked for, or none, before
 * the last page, so only an empty or missing cursor ends the list.
 */
export const channelMembersPageSchema = z
  .object({
    members: z.array(z.string().min(1)).describe("The user IDs of the channel's members"),
    response_metadata: z
      .object({
        next_cursor: z.string().nullish().describe("The next page's cursor, empty after the last"),
      })
      .nullish(),
  })
  .describe("A page of a channel's members")
  .transform((page): ChannelMembersPage => ({
    members: page.members,
    nextCursor: page.response_metadata?.next_cursor || null,
  }));

function channelKind(conversation: {
  is_im?: boolean | null;
  is_mpim?: boolean | null;
  is_private?: boolean | null;
}): ChannelKind {
  if (conversation.is_im) return "im";
  if (conversation.is_mpim) return "mpim";
  return conversation.is_private ? "private" : "public";
}

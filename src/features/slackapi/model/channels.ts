import { z } from "zod";

// Channels as conversations.info describes them.
//
// The bridge keeps only what decides who can read a channel: its kind, whether it's archived,
// whether our bot is in it, and the three flags that say it's shared beyond the workspace. Slack
// adds fields without notice, so unknown keys are dropped. A conversation that leaves out an
// archive or sharing flag is refused rather than assumed unshared, and one that leaves out whether
// it's private reads as public, the wider audience.

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

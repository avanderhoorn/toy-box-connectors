import type { ChannelSuspendReason } from "./audience";

// Why a link is suspended.
//
// The bridge suspends a link when Slack makes continuing unsafe, and the link keeps its settings
// and data until someone resumes or unlinks it. Resuming can widen who reads the lead again, so
// only the owner can. A link whose Slack channel has a new ID ends only with unlink and then a
// link to the new ID. Each reason says why after "suspended", and what ends it, for the banner and
// status. What ends it names the link's Toy Box channel, so it runs as printed at a terminal, where
// status shows every link, and for the lead, which may name its own.

/** Why the bridge suspended a link. */
export type SuspendReason =
  /** Slack gave its channel a new ID, as it can when shared, which unlink and a new link end. */
  "channel_id_changed" | ChannelSuspendReason;

/**
 * Why a link is suspended, as a clause that reads after "suspended", and what ends it, for the link
 * of the Toy Box channel it's given.
 */
type Suspension = { because: string; fix: (channelId: string) => string };

/** `toy-box-slack <command>` for the link of the Toy Box channel `channelId`, in backticks. */
export function channelCommand(command: "resume" | "unlink", channelId: string): string {
  return `\`toy-box-slack ${command} --channel ${channelId}\``;
}

const resume = (channelId: string) =>
  `then have the owner run ${channelCommand("resume", channelId)}.`;

export const suspensions: Record<SuspendReason, Suspension> = {
  channel_id_changed: {
    because: "because Slack gave its channel a new ID",
    fix: (channelId) =>
      `Run ${channelCommand("unlink", channelId)}, then have the owner link the channel again by its new ID.`,
  },
  channel_not_found: {
    because: "because Slack can't find its channel",
    fix: (channelId) => `If the channel still exists, invite the bot back, ${resume(channelId)}`,
  },
  channel_archived: {
    because: "because its Slack channel was archived",
    fix: (channelId) => `Unarchive the channel with the bot in it, ${resume(channelId)}`,
  },
  bot_removed: {
    because: "because the bot was removed from its Slack channel",
    fix: (channelId) => `Invite the bot back to the channel, ${resume(channelId)}`,
  },
  channel_restricted: {
    because: "because a Slack admin setting stops the bot posting in its channel",
    fix: (channelId) => `Ask a Slack admin to let the bot post there, ${resume(channelId)}`,
  },
  workspaces_unknown: {
    because: "because Slack didn't say which workspaces can read its Slack channel",
    fix: (channelId) =>
      `Have the owner run ${channelCommand("resume", channelId)} to check the channel again.`,
  },
  channel_external: {
    because: "because its Slack channel is shared with another organization",
    fix: (channelId) => `Stop sharing the channel outside the organization, ${resume(channelId)}`,
  },
  channel_made_public: {
    because: "because its Slack channel was made public",
    fix: (channelId) =>
      `Have the owner run ${channelCommand("resume", channelId)} to accept who can read it now.`,
  },
  workspace_joined: {
    because: "because a workspace the owner didn't approve joined its Slack channel",
    fix: (channelId) =>
      `Have the owner run ${channelCommand("resume", channelId)} to accept who can read it now.`,
  },
};

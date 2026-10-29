import type { ChannelSuspendReason } from "./audience";

// Why a link is suspended.
//
// The bridge suspends a link when Slack makes continuing unsafe, and the link keeps its settings
// and data until someone resumes or unlinks it. Resuming can widen who reads the lead again, so
// only the owner can. A link whose Slack channel has a new ID ends only with unlink and then a
// link to the new ID. Each reason says why after "suspended", and what ends it, for the banner and
// status.

/** Why the bridge suspended a link. */
export type SuspendReason =
  /** Slack gave its channel a new ID, as it can when shared, which unlink and a new link end. */
  "channel_id_changed" | ChannelSuspendReason;

/** Why a link is suspended, as a clause that reads after "suspended", and what ends it. */
export type Suspension = { because: string; fix: string };

const resume = "then have the owner run `toy-box-slack resume`.";

export const suspensions: Record<SuspendReason, Suspension> = {
  channel_id_changed: {
    because: "because Slack gave its channel a new ID",
    fix: "Run `toy-box-slack unlink`, then have the owner link the channel again by its new ID.",
  },
  channel_not_found: {
    because: "because Slack can't find its channel",
    fix: `If the channel still exists, invite the bot back, ${resume}`,
  },
  channel_archived: {
    because: "because its Slack channel was archived",
    fix: `Unarchive the channel with the bot in it, ${resume}`,
  },
  bot_removed: {
    because: "because the bot was removed from its Slack channel",
    fix: `Invite the bot back to the channel, ${resume}`,
  },
  channel_restricted: {
    because: "because a Slack admin setting stops the bot posting in its channel",
    fix: `Ask a Slack admin to let the bot post there, ${resume}`,
  },
  workspaces_unknown: {
    because: "because Slack didn't say which workspaces can read its Slack channel",
    fix: "Have the owner run `toy-box-slack resume` to check the channel again.",
  },
  channel_external: {
    because: "because its Slack channel is shared with another organization",
    fix: `Stop sharing the channel outside the organization, ${resume}`,
  },
  channel_made_public: {
    because: "because its Slack channel was made public",
    fix: "Have the owner run `toy-box-slack resume` to accept who can read it now.",
  },
  workspace_joined: {
    because: "because a workspace the owner didn't approve joined its Slack channel",
    fix: "Have the owner run `toy-box-slack resume` to accept who can read it now.",
  },
};

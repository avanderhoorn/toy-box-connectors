import type { Audience } from "@links/model/audience";
import type { SlackTs } from "@slackapi/model/ts";

// Stored links.

/** A link's settings for the Slack channel it watches, with the people it allows. */
export type ChannelLink = {
  id: string;
  status: "active" | "paused" | "suspended";
  requestMode: "mention" | "all";
  observe: "requesters" | "channel";
  linkedAtTs: SlackTs;
  /** The channel's audience as the owner last approved it. */
  approved: Audience;
  /** The allowed people's user IDs. */
  allowlist: ReadonlySet<string>;
};

/** The link that watches a Slack channel, whatever its status. */
export async function readChannelLink(
  sql: Bun.SQL,
  slackChannelId: string,
): Promise<ChannelLink | null> {
  const [link] = await sql<(Omit<ChannelLink, "approved" | "allowlist"> & { approved: string })[]>`
    SELECT id, status, request_mode AS requestMode, observe, linked_at_ts AS linkedAtTs,
      approved_audience AS approved
    FROM links WHERE slack_channel_id = ${slackChannelId}
  `;
  if (!link) return null;
  const allowed = await sql<{ user_id: string }[]>`
    SELECT user_id FROM allowlist WHERE link_id = ${link.id}
  `;
  return {
    ...link,
    approved: JSON.parse(link.approved) as Audience,
    allowlist: new Set(allowed.map((entry) => entry.user_id)),
  };
}

import type { ApprovedAudience, ChannelRoles } from "@links/model/audience";
import type { SlackTs } from "@slackapi/model/ts";

// Stored links.

/** A link's settings for the Slack channel it watches, with the people it allows. */
export type ChannelLink = {
  id: string;
  status: "active" | "paused" | "suspended";
  requestMode: "mention" | "all";
  observe: "requesters" | "channel";
  linkedAtTs: SlackTs;
  /** The allowed people's user IDs. */
  allowlist: ReadonlySet<string>;
};

/** The link that watches a Slack channel, whatever its status. */
export async function readChannelLink(
  sql: Bun.SQL,
  slackChannelId: string,
): Promise<ChannelLink | null> {
  const [link] = await sql<Omit<ChannelLink, "allowlist">[]>`
    SELECT id, status, request_mode AS requestMode, observe, linked_at_ts AS linkedAtTs
    FROM links WHERE slack_channel_id = ${slackChannelId}
  `;
  if (!link) return null;
  const allowed = await sql<{ user_id: string }[]>`
    SELECT user_id FROM allowlist WHERE link_id = ${link.id}
  `;
  return { ...link, allowlist: new Set(allowed.map((entry) => entry.user_id)) };
}

/** A link that uses a channel, the roles it uses it in, and the audiences the owner approved. */
export type ChannelUse = ChannelRoles & { linkId: string; approved: ApprovedAudience };

/** Every link that watches a channel or publishes to it, whatever its status. */
export async function readChannelUses(sql: Bun.SQL, channelId: string): Promise<ChannelUse[]> {
  const rows = await sql<
    {
      id: string;
      slack_channel_id: string;
      publish_channel_id: string;
      approved_audience: string;
    }[]
  >`
    SELECT id, slack_channel_id, publish_channel_id, approved_audience FROM links
    WHERE slack_channel_id = ${channelId} OR publish_channel_id = ${channelId}
    ORDER BY id
  `;
  return rows.map((row) => ({
    linkId: row.id,
    monitored: row.slack_channel_id === channelId,
    publish: row.publish_channel_id === channelId,
    approved: JSON.parse(row.approved_audience) as ApprovedAudience,
  }));
}

import type { Audience } from "@links/model/audience";
import type { SuspendReason } from "@links/model/status";
import type { SlackTs } from "@slackapi/model/ts";

// Stored links.

/** A link's settings for the Slack channel it watches, with the people it allows. */
export type ChannelLink = {
  id: string;
  toyBoxChannelId: string;
  slackChannelId: string;
  /** The channel's name as Slack last described it, or null before it has. */
  slackChannelName: string | null;
  status: "active" | "paused" | "suspended";
  /** Why the bridge suspended the link, while it's suspended. */
  statusReason: SuspendReason | null;
  requestMode: "mention" | "all";
  observe: "requesters" | "channel";
  linkedAtTs: SlackTs;
  /** The channel's audience as the owner last approved it. */
  approved: Audience;
  /** The allowed people's user IDs. */
  allowlist: ReadonlySet<string>;
};

/** The link that watches a Slack channel, whatever its status. */
export function readChannelLink(sql: Bun.SQL, slackChannelId: string): Promise<ChannelLink | null> {
  return readLink(sql, "slack_channel_id", slackChannelId);
}

/** The link of a Toy Box channel, whatever its status. */
export function readToyBoxLink(sql: Bun.SQL, toyBoxChannelId: string): Promise<ChannelLink | null> {
  return readLink(sql, "toybox_channel_id", toyBoxChannelId);
}

async function readLink(
  sql: Bun.SQL,
  column: "slack_channel_id" | "toybox_channel_id",
  channelId: string,
): Promise<ChannelLink | null> {
  const [link] = await sql<(Omit<ChannelLink, "approved" | "allowlist"> & { approved: string })[]>`
    SELECT id, toybox_channel_id AS toyBoxChannelId, slack_channel_id AS slackChannelId,
      slack_channel_name AS slackChannelName, status, status_reason AS statusReason,
      request_mode AS requestMode, observe,
      linked_at_ts AS linkedAtTs, approved_audience AS approved
    FROM links WHERE ${sql(column)} = ${channelId}
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

/** Records the name Slack now gives the link's channel. */
export async function nameLinkChannel(
  transaction: Bun.SQL,
  linkId: string,
  name: string,
  now: number,
): Promise<void> {
  await transaction`
    UPDATE links SET slack_channel_name = ${name}, updated_at = ${now}
    WHERE id = ${linkId} AND slack_channel_name IS NOT ${name}
  `;
}

/** Lets the person `userId` make the link's lead act. */
export async function allowPerson(
  transaction: Bun.SQL,
  linkId: string,
  userId: string,
  now: number,
): Promise<void> {
  await transaction`
    INSERT INTO allowlist ${transaction({ link_id: linkId, user_id: userId, added_at: now })}
  `;
}

/** Stops the people `userIds` names making the link's lead act. */
export async function denyPeople(
  transaction: Bun.SQL,
  linkId: string,
  userIds: readonly string[],
): Promise<void> {
  await transaction`
    DELETE FROM allowlist WHERE link_id = ${linkId} AND user_id IN ${transaction([...userIds])}
  `;
}

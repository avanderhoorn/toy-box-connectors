import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import {
  channelMembersPageSchema,
  slackConversationSchema,
  type ChannelFacts,
  type ChannelKind,
  type ChannelMembersPage,
} from "@slackapi/model/channels";

// Channel facts.
//
// A read asks conversations.info, or a page of conversations.members, and keeps nothing, so
// whoever reads decides what the answer means before storing it. A row holds what
// conversations.info last said about a channel and when the read that said it began. A lifecycle
// signal invalidates the row rather than deleting it, so the next refresh still compares against
// what it held. A write clears only an invalidation that came before its read began, and never
// replaces a row read later than its own.

/**
 * What conversations.info says about `channelId` now, or null when Slack can't find it, as it says
 * of a private channel the bot isn't in. Throws when the read fails or returns something that isn't
 * a conversation, which never means anything about the channel.
 */
export async function fetchChannelFacts(
  client: WebClient,
  channelId: string,
): Promise<ChannelFacts | null> {
  try {
    const response = await client.conversations.info({ channel: channelId });
    return slackConversationSchema.parse(response.channel);
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "channel_not_found") {
      return null;
    }
    throw error;
  }
}

/** How many people a page of conversations.members asks for, the most Slack gives at once. */
export const MEMBERS_PAGE_SIZE = 1000;

/**
 * One page of the people in `channelId`, from `cursor` or the start, or null when Slack can't find
 * the channel. Each page is its own call, so a caller pages through BotClient.call one at a time.
 * Throws when the read fails or returns something that isn't a page.
 */
export async function fetchChannelMembers(
  client: WebClient,
  channelId: string,
  cursor: string | null,
): Promise<ChannelMembersPage | null> {
  try {
    const response = await client.conversations.members({
      channel: channelId,
      limit: MEMBERS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    return channelMembersPageSchema.parse(response);
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "channel_not_found") {
      return null;
    }
    throw error;
  }
}

/** A channel's stored facts, when they were read, and whether anything has cast doubt on them. */
export type ChannelInfo = {
  facts: ChannelFacts;
  refreshedAt: number;
  /** When the latest signal said the facts may have changed since they were read, or null. */
  invalidatedAt: number | null;
};

type ChannelInfoRow = {
  channel_id: string;
  name: string | null;
  kind: ChannelKind;
  is_member: number;
  is_archived: number;
  is_ext_shared: number;
  is_pending_ext_shared: number;
  is_org_shared: number;
  enterprise_id: string | null;
  context_team_id: string | null;
  shared_team_ids: string;
  refreshed_at: number;
  invalidated_at: number | null;
};

/** A channel's stored facts, or null when the bridge has never read it. */
export async function readChannelInfo(
  sql: Bun.SQL,
  channelId: string,
): Promise<ChannelInfo | null> {
  const [row] = await sql<ChannelInfoRow[]>`
    SELECT * FROM channel_info WHERE channel_id = ${channelId}
  `;
  if (!row) return null;
  return {
    facts: {
      id: row.channel_id,
      name: row.name,
      kind: row.kind,
      isMember: row.is_member === 1,
      isArchived: row.is_archived === 1,
      isExtShared: row.is_ext_shared === 1,
      isPendingExtShared: row.is_pending_ext_shared === 1,
      isOrgShared: row.is_org_shared === 1,
      enterpriseId: row.enterprise_id,
      contextTeamId: row.context_team_id,
      sharedTeamIds: JSON.parse(row.shared_team_ids) as string[],
    },
    refreshedAt: row.refreshed_at,
    invalidatedAt: row.invalidated_at,
  };
}

/** Stores the facts a read of the channel returned. `readAt` is when that read began. */
export async function writeChannelInfo(
  transaction: Bun.SQL,
  facts: ChannelFacts,
  readAt: number,
): Promise<void> {
  const row: ChannelInfoRow = {
    channel_id: facts.id,
    name: facts.name,
    kind: facts.kind,
    is_member: facts.isMember ? 1 : 0,
    is_archived: facts.isArchived ? 1 : 0,
    is_ext_shared: facts.isExtShared ? 1 : 0,
    is_pending_ext_shared: facts.isPendingExtShared ? 1 : 0,
    is_org_shared: facts.isOrgShared ? 1 : 0,
    enterprise_id: facts.enterpriseId,
    context_team_id: facts.contextTeamId,
    shared_team_ids: JSON.stringify(facts.sharedTeamIds),
    refreshed_at: readAt,
    invalidated_at: null,
  };
  await transaction`
    INSERT INTO channel_info ${transaction(row)}
    ON CONFLICT(channel_id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      is_member = excluded.is_member,
      is_archived = excluded.is_archived,
      is_ext_shared = excluded.is_ext_shared,
      is_pending_ext_shared = excluded.is_pending_ext_shared,
      is_org_shared = excluded.is_org_shared,
      enterprise_id = excluded.enterprise_id,
      context_team_id = excluded.context_team_id,
      shared_team_ids = excluded.shared_team_ids,
      refreshed_at = excluded.refreshed_at,
      invalidated_at = CASE
        WHEN channel_info.invalidated_at >= excluded.refreshed_at THEN channel_info.invalidated_at
      END
    WHERE excluded.refreshed_at >= channel_info.refreshed_at
  `;
}

/** Casts doubt on a channel's stored facts, so nothing relies on them until a fresh read. */
export async function invalidateChannelInfo(
  transaction: Bun.SQL,
  channelId: string,
  now: number,
): Promise<void> {
  await transaction`
    UPDATE channel_info SET invalidated_at = ${now}
    WHERE channel_id = ${channelId} AND (invalidated_at IS NULL OR invalidated_at < ${now})
  `;
}

/** The ID a channel has now, which differs from `channelId` when Slack moved it from there. */
export async function currentChannelId(sql: Bun.SQL, channelId: string): Promise<string> {
  const [alias] = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM channel_aliases WHERE old_id = ${channelId}
  `;
  return alias?.channel_id ?? channelId;
}

/**
 * Records that Slack moved a channel from `oldId` to `newId`. Aliases of the old ID follow it, so
 * each names a current ID, and a channel moved back to an ID it had before loses that alias.
 */
export async function recordChannelAlias(
  transaction: Bun.SQL,
  oldId: string,
  newId: string,
  now: number,
): Promise<void> {
  await transaction`DELETE FROM channel_aliases WHERE old_id = ${newId}`;
  await transaction`UPDATE channel_aliases SET channel_id = ${newId} WHERE channel_id = ${oldId}`;
  await transaction`
    INSERT INTO channel_aliases (old_id, channel_id, changed_at) VALUES (${oldId}, ${newId}, ${now})
    ON CONFLICT(old_id) DO UPDATE SET channel_id = excluded.channel_id, changed_at = excluded.changed_at
  `;
}

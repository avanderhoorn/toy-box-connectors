import type { ChannelFacts, ChannelKind } from "@slackapi/model/channels";

// Stored channel facts.
//
// A row holds what conversations.info last said about a channel and when the read that said it
// began. A lifecycle signal invalidates the row rather than deleting it, so the next refresh still
// compares against what it held. A write clears only an invalidation that came before its read
// began, and never replaces a row read later than its own.

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

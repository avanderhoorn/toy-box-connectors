import type { SuspendReason } from "@links/model/status";
import { moveOutboxChannel } from "@outbox/server/database";
import { invalidateChannelInfo, recordChannelAlias } from "@slackapi/server/channels";
import { readChannelLink } from "./database";
import { suspendLink } from "./status";

// Slack's lifecycle signals.
//
// The receiver calls these in the delivery's transaction, before the ack, when Slack says a linked
// channel can't be used as the owner approved it, moved to a new ID, or the app is gone. Each
// returns what the caller acts on once the transaction commits: the links whose status changed, so
// it reconsiders their wakes, or the local copies of the files uninstalling forgot, so it removes
// them.

/**
 * Suspends the link that watches a channel a signal says can't be used as the owner approved, and
 * casts doubt on what's stored about the channel. A channel made public suspends the link only if
 * the owner approved it private. Returns the links whose status changed.
 */
export async function suspendChannelLinks(
  transaction: Bun.SQL,
  channelId: string,
  reason: SuspendReason,
  now: number,
): Promise<string[]> {
  await invalidateChannelInfo(transaction, channelId, now);
  const link = await readChannelLink(transaction, channelId);
  if (!link) return [];
  if (reason === "channel_made_public" && link.approved.kind === "public") return [];
  return (await suspendLink(transaction, link.id, reason, now)) ? [link.id] : [];
}

/**
 * Follows a channel to the new ID Slack gave it. The alias is recorded, the link and every outbox
 * item that name the old ID name the new one, and what's stored about either ID is in doubt. Slack
 * does this when a private channel is shared outside the organization, so the link is suspended
 * until the owner links the channel again. Returns the links whose status changed.
 */
export async function changeChannelId(
  transaction: Bun.SQL,
  oldId: string,
  newId: string,
  now: number,
): Promise<string[]> {
  if (oldId === newId) return [];
  await recordChannelAlias(transaction, oldId, newId, now);
  await transaction`
    UPDATE links SET slack_channel_id = ${newId}, updated_at = ${now}
    WHERE slack_channel_id = ${oldId}
  `;
  await moveOutboxChannel(transaction, oldId, newId);
  await invalidateChannelInfo(transaction, oldId, now);
  return suspendChannelLinks(transaction, newId, "channel_id_changed", now);
}

/**
 * Records that the app was uninstalled or its bot token revoked, and deletes everything else the
 * bridge kept, settings included. The installation stays, marked uninstalled, so the bridge won't
 * start again on tokens Slack revoked. Returns the local copies of the files it forgot, and nothing
 * once the installation is uninstalled already.
 */
export async function recordUninstall(transaction: Bun.SQL): Promise<string[]> {
  const uninstalled = await transaction`
    UPDATE installation SET status = 'uninstalled' WHERE status <> 'uninstalled' RETURNING id
  `;
  if (!uninstalled.length) return [];
  const copies = await transaction<{ local_path: string }[]>`
    SELECT local_path FROM files WHERE local_path IS NOT NULL
  `;
  // SQLite's own tables stay, so numbers keep counting from where they were.
  const tables = await transaction<{ name: string }[]>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'installation'
  `;
  // Every table empties in this transaction, so the order they go in can't break a reference.
  await transaction`PRAGMA defer_foreign_keys = ON`;
  for (const { name } of tables) await transaction`DELETE FROM ${transaction(name)}`;
  return copies.map((copy) => copy.local_path);
}

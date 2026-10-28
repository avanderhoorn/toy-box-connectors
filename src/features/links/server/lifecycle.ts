import { signalSuspends, type ChannelSuspendReason } from "@links/model/audience";
import { moveOutboxChannel } from "@outbox/server/database";
import { invalidateChannelInfo, recordChannelAlias } from "@slackapi/server/channels";
import { readChannelUses } from "./database";
import { purgeForUninstall } from "./purge";
import { suspendLink } from "./status";

// Slack's lifecycle signals.
//
// The receiver calls these in the delivery's transaction, before the ack, when Slack says a linked
// channel can't be used as the owner approved it, moved to a new ID, or the app is gone. Each
// returns what the caller acts on once the transaction commits: the links whose status changed, so
// it reconsiders their wakes, or the local copies of the files a purge forgot, so it removes them.

/**
 * Suspends every link that uses a channel a signal says can't be used as the owner approved, and
 * casts doubt on what's stored about the channel. A channel made public suspends only a link the
 * owner approved it private for. Returns the links whose status changed.
 */
export async function suspendChannelLinks(
  transaction: Bun.SQL,
  channelId: string,
  reason: ChannelSuspendReason,
  now: number,
): Promise<string[]> {
  await invalidateChannelInfo(transaction, channelId, now);
  const changed: string[] = [];
  for (const use of await readChannelUses(transaction, channelId)) {
    if (!signalSuspends(use.approved, use, reason)) continue;
    if (await suspendLink(transaction, use.linkId, reason, now)) changed.push(use.linkId);
  }
  return changed;
}

/**
 * Follows a channel to the new ID Slack gave it. The alias is recorded, every link, card, claim
 * and outbox item that names the old ID names the new one, and what's stored about either ID is
 * in doubt. Slack does this when a private channel is shared outside the organization, so every
 * link that uses the channel is suspended until the owner approves it as it is now. Returns the
 * links whose status changed.
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
  await transaction`
    UPDATE links SET publish_channel_id = ${newId}, updated_at = ${now}
    WHERE publish_channel_id = ${oldId}
  `;
  await transaction`UPDATE approvals SET card_channel_id = ${newId} WHERE card_channel_id = ${oldId}`;
  await transaction`
    UPDATE claims SET posted_channel_id = ${newId} WHERE posted_channel_id = ${oldId}
  `;
  await moveOutboxChannel(transaction, oldId, newId);
  await invalidateChannelInfo(transaction, oldId, now);
  await invalidateChannelInfo(transaction, newId, now);
  const changed: string[] = [];
  for (const use of await readChannelUses(transaction, newId)) {
    if (await suspendLink(transaction, use.linkId, "channel_id_changed", now)) {
      changed.push(use.linkId);
    }
  }
  return changed;
}

/**
 * Records that the app was uninstalled or its bot token revoked. The installation is marked
 * uninstalled with no owner, and every row of Slack data, settings included, is purged but the
 * record that the purge happened. The bridge won't start again until reset. Returns the local
 * copies of the files it forgot, and nothing once the installation is uninstalled already.
 */
export async function recordUninstall(transaction: Bun.SQL, now: number): Promise<string[]> {
  const uninstalled = await transaction`
    UPDATE installation SET status = 'uninstalled', owner_user_id = NULL
    WHERE status <> 'uninstalled'
    RETURNING id
  `;
  if (!uninstalled.length) return [];
  return purgeForUninstall(transaction, now);
}

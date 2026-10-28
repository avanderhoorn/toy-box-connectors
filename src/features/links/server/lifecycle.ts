import type { SuspendReason } from "@links/model/status";
import { readChannelLink } from "./database";
import { suspendLink } from "./status";

// Slack's lifecycle signals.
//
// The receiver calls these in the delivery's transaction, before the ack, when Slack says a linked
// channel can't be used as the owner approved it, or the app is gone. A channel given a new ID is
// one Slack shared outside the organization, so its link is suspended under the old ID until the
// owner links the channel again.

/**
 * Suspends the link that watches a channel a signal says can't be used as the owner approved.
 * A channel made public suspends the link only if
 * the owner approved it private. Returns the links whose status changed.
 */
export async function suspendChannelLinks(
  transaction: Bun.SQL,
  channelId: string,
  reason: SuspendReason,
  now: number,
): Promise<string[]> {
  const link = await readChannelLink(transaction, channelId);
  if (!link) return [];
  if (reason === "channel_made_public" && link.approved.kind === "public") return [];
  return (await suspendLink(transaction, link.id, reason, now)) ? [link.id] : [];
}

/**
 * Records that the app was uninstalled or its bot token revoked, and deletes everything else the
 * bridge kept, settings included. The installation stays, marked uninstalled, so the bridge won't
 * start again on tokens Slack revoked. Once the installation is uninstalled already, it does
 * nothing.
 */
export async function recordUninstall(transaction: Bun.SQL): Promise<void> {
  const uninstalled = await transaction`
    UPDATE installation SET status = 'uninstalled' WHERE status <> 'uninstalled' RETURNING id
  `;
  if (!uninstalled.length) return;
  // SQLite's own tables stay, so numbers keep counting from where they were.
  const tables = await transaction<{ name: string }[]>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'installation'
  `;
  // Every table empties in this transaction, so the order they go in can't break a reference.
  await transaction`PRAGMA defer_foreign_keys = ON`;
  for (const { name } of tables) await transaction`DELETE FROM ${transaction(name)}`;
}

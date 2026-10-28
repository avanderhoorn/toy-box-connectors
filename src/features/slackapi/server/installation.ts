import type { SlackIdentity } from "@slackapi/model/identity";
import type { Installation, InstallationStatus } from "@slackapi/model/installation";

// The stored installation.

type InstallationRow = {
  team_id: string;
  app_id: string;
  bot_id: string;
  bot_user_id: string;
  enterprise_id: string | null;
  owner_user_id: string | null;
  status: InstallationStatus;
};

/** The installation, or null before the bridge has first confirmed its tokens with Slack. */
export async function readInstallation(sql: Bun.SQL): Promise<Installation | null> {
  const [row] = await sql<InstallationRow[]>`
    SELECT team_id, app_id, bot_id, bot_user_id, enterprise_id, owner_user_id, status
    FROM installation
  `;
  if (!row) return null;
  return {
    teamId: row.team_id,
    appId: row.app_id,
    botId: row.bot_id,
    botUserId: row.bot_user_id,
    enterpriseId: row.enterprise_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
  };
}

/** Records the installation Slack first confirmed the tokens for, active and with no owner yet. */
export async function recordInstallation(
  transaction: Bun.SQL,
  identity: SlackIdentity,
): Promise<void> {
  const row = {
    id: 1,
    team_id: identity.teamId,
    app_id: identity.appId,
    bot_id: identity.botId,
    bot_user_id: identity.botUserId,
    enterprise_id: identity.enterpriseId,
    status: "active",
  };
  await transaction`INSERT INTO installation ${transaction(row)}`;
}

/**
 * Puts an installation in auth_failed back to active, and returns when it began failing, which is
 * where recovery's gap starts, or null when it wasn't failing. A failure that wasn't timed counts
 * from the epoch, so its gap reaches back to when each link began.
 */
export async function reactivateInstallation(transaction: Bun.SQL): Promise<number | null> {
  const [failing] = await transaction<{ auth_failed_at: number | null }[]>`
    SELECT auth_failed_at FROM installation WHERE status = 'auth_failed'
  `;
  if (!failing) return null;
  await transaction`UPDATE installation SET status = 'active', auth_failed_at = NULL`;
  return failing.auth_failed_at ?? 0;
}

/**
 * Puts an active installation in auth_failed as of `now`, and returns whether it changed. One
 * that's failing already keeps the moment it began, where recovery's gap starts, and an uninstalled
 * one stays uninstalled.
 */
export async function markAuthFailed(transaction: Bun.SQL, now: number): Promise<boolean> {
  const marked = await transaction`
    UPDATE installation SET status = 'auth_failed', auth_failed_at = ${now}
    WHERE status = 'active'
    RETURNING id
  `;
  return marked.length > 0;
}

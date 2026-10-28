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

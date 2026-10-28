import type { SlackIdentity } from "@slackapi/model/identity";
import type { Installation } from "@slackapi/model/installation";

export async function readInstallation(sql: Bun.SQL): Promise<Installation | null> {
  const [row] = await sql<Installation[]>`
    SELECT team_id AS teamId, app_id AS appId, bot_id AS botId, bot_user_id AS botUserId,
      enterprise_id AS enterpriseId, status FROM installation
  `;
  return row ?? null;
}

export async function recordInstallation(tx: Bun.SQL, identity: SlackIdentity): Promise<void> {
  await tx`
    INSERT INTO installation (id, team_id, app_id, bot_id, bot_user_id, enterprise_id, status)
    VALUES (1, ${identity.teamId}, ${identity.appId}, ${identity.botId}, ${identity.botUserId}, ${identity.enterpriseId}, 'active')
  `;
}

/** Recovery starts at the first rejection, never the latest one. */
export async function reactivateInstallation(tx: Bun.SQL): Promise<number | null> {
  const [row] = await tx<{ auth_failed_at: number | null }[]>`
    SELECT auth_failed_at FROM installation WHERE status = 'auth_failed'
  `;
  if (!row) return null;
  await tx`UPDATE installation SET status = 'active', auth_failed_at = NULL`;
  return row.auth_failed_at ?? 0;
}

export async function markAuthFailed(tx: Bun.SQL, now: number): Promise<boolean> {
  const rows = await tx`
    UPDATE installation SET status = 'auth_failed', auth_failed_at = ${now}
    WHERE status = 'active' RETURNING id
  `;
  return rows.length > 0;
}

export async function readConnectedAt(sql: Bun.SQL): Promise<number | null> {
  const [row] = await sql<{ connected_at: number | null }[]>`SELECT connected_at FROM installation`;
  return row?.connected_at ?? null;
}

export async function markConnected(tx: Bun.SQL, at: number): Promise<void> {
  await tx`UPDATE installation SET connected_at = ${at}`;
}

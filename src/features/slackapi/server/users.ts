import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { personIds, slackUserSchema, type SlackPerson } from "@slackapi/model/users";

/** Admission always reads fresh facts. Stored names and aliases confer no authority. */
export async function fetchSlackPerson(
  client: WebClient,
  userId: string,
): Promise<SlackPerson | null> {
  try {
    return slackUserSchema.parse((await client.users.info({ user: userId })).user);
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "user_not_found") return null;
    throw error;
  }
}

export async function writeSlackPerson(
  tx: Bun.SQL,
  person: SlackPerson,
  readAt: number,
): Promise<void> {
  await tx`
    INSERT INTO users ${tx({
      user_id: person.id,
      display_name: person.displayName,
      real_name: person.realName,
      is_bot: person.isBot || person.isWorkflowBot ? 1 : person.isBot === null ? null : 0,
      refreshed_at: readAt,
    })}
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name, real_name = excluded.real_name,
      is_bot = excluded.is_bot, refreshed_at = excluded.refreshed_at
    WHERE users.refreshed_at IS NULL OR excluded.refreshed_at >= users.refreshed_at
  `;
  for (const aliasId of personIds(person).slice(1)) {
    await tx`
      INSERT INTO user_aliases (alias_id, user_id) VALUES (${aliasId}, ${person.id})
      ON CONFLICT(alias_id) DO UPDATE SET user_id = excluded.user_id
    `;
  }
}

export async function canonicalUserId(sql: Bun.SQL, userId: string): Promise<string> {
  const [alias] = await sql<
    { user_id: string }[]
  >`SELECT user_id FROM user_aliases WHERE alias_id = ${userId}`;
  return alias?.user_id ?? userId;
}

export async function readPersonIds(sql: Bun.SQL, userId: string): Promise<string[]> {
  const canonical = await canonicalUserId(sql, userId);
  const aliases = await sql<{ alias_id: string }[]>`
    SELECT alias_id FROM user_aliases WHERE user_id = ${canonical} ORDER BY alias_id
  `;
  return [...new Set([canonical, ...aliases.map((alias) => alias.alias_id), userId])];
}

export async function readBotUserIds(sql: Bun.SQL): Promise<Set<string>> {
  const bots = await sql<{ user_id: string }[]>`SELECT user_id FROM users WHERE is_bot = 1`;
  return new Set(bots.map((bot) => bot.user_id));
}

export async function readSlackPersonName(sql: Bun.SQL, userId: string): Promise<string | null> {
  const [row] = await sql<{ real_name: string | null; display_name: string | null }[]>`
    SELECT real_name, display_name FROM users WHERE user_id = ${await canonicalUserId(sql, userId)}
  `;
  return row?.real_name ?? row?.display_name ?? null;
}

import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { personIds, slackUserSchema, type SlackPerson } from "@slackapi/model/users";

// Stored people.
//
// users.info is the only thing the bridge trusts about who someone is. A lookup reads them fresh,
// and a write keeps what it said along with any other ID Slack gave them, as an alias, so a message
// or click carrying either ID counts as theirs.

/**
 * What users.info says about `userId` now, or null when Slack doesn't know them. Throws when the
 * lookup fails or returns something that isn't a user, which never means anything about them.
 */
export async function fetchSlackPerson(
  client: WebClient,
  userId: string,
): Promise<SlackPerson | null> {
  try {
    const response = await client.users.info({ user: userId });
    return slackUserSchema.parse(response.user);
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "user_not_found") return null;
    throw error;
  }
}

type UserRow = {
  user_id: string;
  team_id: string | null;
  enterprise_id: string | null;
  display_name: string | null;
  real_name: string | null;
  is_bot: number | null;
  deleted: number;
  refreshed_at: number;
};

/**
 * Stores what users.info said about `person`, and their other ID as an alias. `readAt` is when
 * that read began, and a write never replaces what a later read said.
 */
export async function writeSlackPerson(
  transaction: Bun.SQL,
  person: SlackPerson,
  readAt: number,
): Promise<void> {
  const row: UserRow = {
    user_id: person.id,
    team_id: person.teamId,
    enterprise_id: person.enterpriseId,
    display_name: person.displayName,
    real_name: person.realName,
    is_bot: person.isBot || person.isWorkflowBot ? 1 : person.isBot === null ? null : 0,
    deleted: person.deleted ? 1 : 0,
    refreshed_at: readAt,
  };
  await transaction`
    INSERT INTO users ${transaction(row)}
    ON CONFLICT(user_id) DO UPDATE SET
      team_id = excluded.team_id,
      enterprise_id = excluded.enterprise_id,
      display_name = excluded.display_name,
      real_name = excluded.real_name,
      is_bot = excluded.is_bot,
      deleted = excluded.deleted,
      refreshed_at = excluded.refreshed_at
    WHERE users.refreshed_at IS NULL OR excluded.refreshed_at >= users.refreshed_at
  `;
  for (const aliasId of personIds(person).slice(1)) {
    await transaction`
      INSERT INTO user_aliases ${transaction({ alias_id: aliasId, user_id: person.id })}
      ON CONFLICT(alias_id) DO UPDATE SET user_id = excluded.user_id
    `;
  }
}

/** The user ID that `userId` counts as: the person it's an alias for, or itself. */
export async function canonicalUserId(sql: Bun.SQL, userId: string): Promise<string> {
  const [alias] = await sql<{ user_id: string }[]>`
    SELECT user_id FROM user_aliases WHERE alias_id = ${userId}
  `;
  return alias?.user_id ?? userId;
}

/**
 * Every ID the person `userId` counts as is known by: the one users.info gave them, then each
 * alias stored for them, and `userId` itself.
 */
export async function readPersonIds(sql: Bun.SQL, userId: string): Promise<string[]> {
  const canonical = await canonicalUserId(sql, userId);
  const aliases = await sql<{ alias_id: string }[]>`
    SELECT alias_id FROM user_aliases WHERE user_id = ${canonical} ORDER BY alias_id
  `;
  return [...new Set([canonical, ...aliases.map((alias) => alias.alias_id), userId])];
}

/** The users Slack said are bots, which a message's user ID alone doesn't tell apart from people. */
export async function readBotUserIds(sql: Bun.SQL): Promise<Set<string>> {
  const bots = await sql<{ user_id: string }[]>`SELECT user_id FROM users WHERE is_bot = 1`;
  return new Set(bots.map((bot) => bot.user_id));
}

/** The name Slack shows `userId` by, their real name before their display name, or null when unknown. */
export async function readSlackPersonName(sql: Bun.SQL, userId: string): Promise<string | null> {
  const [row] = await sql<Pick<UserRow, "real_name" | "display_name">[]>`
    SELECT real_name, display_name FROM users WHERE user_id = ${await canonicalUserId(sql, userId)}
  `;
  return row?.real_name ?? row?.display_name ?? null;
}

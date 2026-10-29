import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { slackUserSchema, type SlackPerson } from "@slackapi/model/users";

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

export async function writeSlackPerson(tx: Bun.SQL, person: SlackPerson): Promise<void> {
  await tx`
    INSERT INTO users ${tx({
      user_id: person.id,
      display_name: person.displayName,
      real_name: person.realName,
    })}
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name, real_name = excluded.real_name
  `;
  if (person.enterpriseUserId && person.enterpriseUserId !== person.id) {
    await tx`
      INSERT INTO user_aliases (alias_id, user_id) VALUES (${person.enterpriseUserId}, ${person.id})
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

export async function readSlackPersonName(sql: Bun.SQL, userId: string): Promise<string | null> {
  const [row] = await sql<{ real_name: string | null; display_name: string | null }[]>`
    SELECT real_name, display_name FROM users WHERE user_id = ${await canonicalUserId(sql, userId)}
  `;
  return row?.real_name ?? row?.display_name ?? null;
}

export async function initializeSlackApiSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE installation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      team_id TEXT NOT NULL, app_id TEXT NOT NULL, bot_id TEXT NOT NULL, bot_user_id TEXT NOT NULL,
      enterprise_id TEXT,
      -- Versions before 6 stored a token Slack rejected as auth_failed, which version 6 makes active.
      status TEXT NOT NULL CHECK (status IN ('active', 'auth_failed', 'uninstalled')),
      connected_at INTEGER
    );
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT, real_name TEXT
    );
    CREATE TABLE user_aliases (
      alias_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
    );
  `);
}

/**
 * Takes a version 5 `bridge.db` to version 6, which remembers a token Slack rejected only until the
 * bridge restarts, so an installation stored as rejected is active again.
 */
export async function forgetAuthFailure(db: Bun.SQL): Promise<void> {
  await db`UPDATE installation SET status = 'active' WHERE status = 'auth_failed'`;
}

export async function initializeSlackApiSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE installation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      team_id TEXT NOT NULL, app_id TEXT NOT NULL, bot_id TEXT NOT NULL, bot_user_id TEXT NOT NULL,
      enterprise_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'auth_failed', 'uninstalled')),
      auth_failed_at INTEGER, connected_at INTEGER, disconnected_at INTEGER
    );
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT, real_name TEXT, is_bot INTEGER CHECK (is_bot IN (0, 1)),
      refreshed_at INTEGER
    );
    CREATE TABLE user_aliases (
      alias_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
    );
  `);
}

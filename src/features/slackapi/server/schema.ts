/** Install the tables whose meaning is owned by the Slack API feature. */
export async function initializeSlackApiSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE installation (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      team_id         TEXT NOT NULL,
      app_id          TEXT NOT NULL,
      bot_id          TEXT NOT NULL,
      bot_user_id     TEXT NOT NULL,
      -- The Enterprise org auth.test names, NULL for a standalone workspace.
      enterprise_id   TEXT,
      owner_user_id   TEXT,
      status          TEXT NOT NULL CHECK (status IN ('active', 'auth_failed', 'uninstalled')),
      auth_failed_at  INTEGER,
      connected_at    INTEGER,
      disconnected_at INTEGER
    );

    -- key is the event ID, the envelope ID of a delivery that has none, or app_rate_limited:<minute>.
    -- A receipt commits with whatever its delivery changed, before the ack, and holds no content.
    CREATE TABLE receipts (
      key         TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN (
        'applied', 'claim', 'unlinked', 'ignored', 'foreign', 'malformed', 'rate_limited', 'interactive'
      ))
    );

    CREATE INDEX receipts_received ON receipts(received_at);

    CREATE TABLE channel_info (
      channel_id            TEXT PRIMARY KEY,
      name                  TEXT,
      kind                  TEXT NOT NULL CHECK (kind IN ('public', 'private', 'im', 'mpim')),
      is_member             INTEGER NOT NULL CHECK (is_member IN (0, 1)),
      is_archived           INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
      is_ext_shared         INTEGER NOT NULL CHECK (is_ext_shared IN (0, 1)),
      is_pending_ext_shared INTEGER NOT NULL CHECK (is_pending_ext_shared IN (0, 1)),
      is_org_shared         INTEGER NOT NULL CHECK (is_org_shared IN (0, 1)),
      enterprise_id         TEXT,
      context_team_id       TEXT,
      -- A sorted JSON array of the workspaces the channel is in, [] when Slack leaves it out.
      shared_team_ids       TEXT NOT NULL,
      refreshed_at          INTEGER NOT NULL,
      invalidated_at        INTEGER
    );

    CREATE TABLE channel_aliases (
      old_id     TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );

    -- Slack user IDs are globally unique, and an Enterprise user keeps one across the org, so a user
    -- isn't keyed by workspace. team_id and enterprise_id are what Slack last said about them.
    CREATE TABLE users (
      user_id       TEXT PRIMARY KEY,
      team_id       TEXT,
      enterprise_id TEXT,
      display_name  TEXT,
      real_name     TEXT,
      is_bot        INTEGER CHECK (is_bot IS NULL OR is_bot IN (0, 1)),
      deleted       INTEGER CHECK (deleted IS NULL OR deleted IN (0, 1)),
      refreshed_at  INTEGER
    );

    -- An Enterprise user's enterprise_user.id, when users.info returned one that differs from their
    -- user ID. A message from either is theirs.
    CREATE TABLE user_aliases (
      alias_id TEXT PRIMARY KEY,
      user_id  TEXT NOT NULL
    );
  `);
}

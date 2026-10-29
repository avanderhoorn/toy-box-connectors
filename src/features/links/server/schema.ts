/** Install the tables whose meaning is owned by Links. */
export async function initializeLinkSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- approved_audience holds the channel's audience as the owner last approved it, which every
    -- later read of the channel is judged against.
    CREATE TABLE links (
      id                  TEXT PRIMARY KEY,
      toybox_channel_id   TEXT NOT NULL UNIQUE,
      slack_channel_id    TEXT NOT NULL UNIQUE,
      request_mode        TEXT NOT NULL DEFAULT 'mention' CHECK (request_mode IN ('mention', 'all')),
      observe             TEXT NOT NULL DEFAULT 'requesters'
        CHECK (observe IN ('requesters', 'channel')),
      status              TEXT NOT NULL CHECK (status IN ('active', 'paused', 'suspended')),
      status_reason       TEXT,
      approved_audience   TEXT NOT NULL CHECK (json_valid(approved_audience)),
      linked_at_ts        TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE TABLE allowlist (
      link_id  TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (link_id, user_id)
    );
  `);
}

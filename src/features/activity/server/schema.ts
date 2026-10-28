/** Install the tables whose meaning is owned by Activity. */
export async function initializeActivitySchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- A kept message has text and a content hash, and a content-free marker or a tombstone has
    -- neither, nor any trace that it mentioned the bot. eligible marks a person's message, the only
    -- kind that can start a request.
    CREATE TABLE messages (
      channel_id   TEXT NOT NULL,
      ts           TEXT NOT NULL,
      thread_ts    TEXT,
      user_id      TEXT,
      team_id      TEXT,
      subtype      TEXT,
      eligible     INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      author_role  TEXT NOT NULL
        CHECK (author_role IN ('allowed', 'observed', 'self', 'other')),
      text         TEXT,
      content_hash TEXT,
      mentions_bot INTEGER NOT NULL DEFAULT 0 CHECK (mentions_bot IN (0, 1)),
      edited_ts    TEXT,
      deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
      version      TEXT NOT NULL,
      updated_seq  INTEGER NOT NULL CHECK (typeof(updated_seq) = 'integer' AND updated_seq > 0),
      PRIMARY KEY (channel_id, ts),
      CHECK (eligible = (author_role IN ('allowed', 'observed'))),
      CHECK ((content_hash IS NULL) = (text IS NULL)),
      CHECK (text IS NOT NULL OR mentions_bot = 0),
      CHECK (text IS NULL OR (deleted = 0 AND author_role <> 'other'))
    );

    CREATE TABLE changes (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id    TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('new', 'edited', 'deleted'))
    );

    -- mark-read never moves the digest cursor past what activity served.
    CREATE TABLE cursors (
      link_id            TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
      through_seq        INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(through_seq) = 'integer' AND through_seq >= 0),
      served_through_seq INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(served_through_seq) = 'integer' AND served_through_seq >= 0),
      CHECK (through_seq <= served_through_seq)
    );

    -- A stretch of time whose events the bridge may have missed. Catch-up reads it from Slack's
    -- history once it has ended.
    CREATE TABLE gaps (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      starts_at INTEGER NOT NULL,
      ends_at   INTEGER NOT NULL
    );
  `);
}

/** Install the tables whose meaning is owned by Activity. */
export async function initializeActivitySchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- A kept message has text, files and a content hash, and a content-free marker or a tombstone
    -- has none of them, nor any trace that it mentioned the bot. eligible marks a person's
    -- message, the only kind that can start a request.
    CREATE TABLE messages (
      channel_id   TEXT NOT NULL,
      ts           TEXT NOT NULL,
      thread_ts    TEXT,
      user_id      TEXT,
      team_id      TEXT,
      subtype      TEXT,
      eligible     INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      author_role  TEXT NOT NULL
        CHECK (author_role IN ('owner', 'allowed', 'observed', 'self', 'other')),
      text         TEXT,
      files        TEXT CHECK (files IS NULL OR json_valid(files)),
      content_hash TEXT,
      mentions_bot INTEGER NOT NULL DEFAULT 0 CHECK (mentions_bot IN (0, 1)),
      edited_ts    TEXT,
      deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
      version      TEXT NOT NULL,
      updated_seq  INTEGER NOT NULL CHECK (typeof(updated_seq) = 'integer' AND updated_seq > 0),
      PRIMARY KEY (channel_id, ts),
      CHECK (eligible = (author_role IN ('owner', 'allowed', 'observed'))),
      CHECK ((content_hash IS NULL) = (text IS NULL)),
      CHECK ((files IS NULL) = (text IS NULL)),
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

    CREATE TABLE threads (
      channel_id      TEXT NOT NULL,
      thread_ts       TEXT NOT NULL,
      tracked_reason  TEXT NOT NULL CHECK (tracked_reason IN ('request')),
      latest_reply_ts TEXT,
      repaired_at     INTEGER,
      PRIMARY KEY (channel_id, thread_ts)
    );

    -- oldest_ts and latest_ts are fixed when the gap is recorded. An invalid cursor restarts from oldest_ts.
    CREATE TABLE coverage (
      id          INTEGER PRIMARY KEY,
      link_id     TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      channel_id  TEXT NOT NULL,
      scope       TEXT NOT NULL CHECK (scope IN ('channel', 'thread')),
      thread_ts   TEXT,
      oldest_ts   TEXT NOT NULL,
      latest_ts   TEXT NOT NULL,
      cursor      TEXT,
      state       TEXT NOT NULL CHECK (state IN ('open', 'repairing', 'repaired', 'partial')),
      reason      TEXT NOT NULL
        CHECK (reason IN ('disconnect', 'rate_limited', 'malformed', 'startup', 'thread')),
      opened_at   INTEGER NOT NULL,
      repaired_at INTEGER,
      CHECK ((thread_ts IS NOT NULL) = (scope = 'thread'))
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

    -- Only a kept message's files are indexed, and a file's row follows the message that last
    -- shared it. size and mime are what Slack reported. local_path is relative to the files folder.
    CREATE TABLE files (
      file_id    TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      state      TEXT NOT NULL CHECK (state IN ('indexed', 'fetched')),
      local_path TEXT,
      size       INTEGER CHECK (size IS NULL OR (typeof(size) = 'integer' AND size >= 0)),
      mime       TEXT,
      fetched_at INTEGER,
      CHECK ((local_path IS NOT NULL) = (state = 'fetched')),
      CHECK ((fetched_at IS NOT NULL) = (state = 'fetched'))
    );

    CREATE INDEX files_message ON files(channel_id, ts);
  `);
}

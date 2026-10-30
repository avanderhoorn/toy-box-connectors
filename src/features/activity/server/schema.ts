/** Install the tables whose meaning is owned by Activity. */
export async function initializeActivitySchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- A kept message has text and a content hash, and a content-free marker or a tombstone has
    -- neither, nor any trace of who wrote it or that it mentioned the bot.
    CREATE TABLE messages (
      channel_id   TEXT NOT NULL,
      ts           TEXT NOT NULL,
      thread_ts    TEXT,
      user_id      TEXT,
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
      CHECK ((content_hash IS NULL) = (text IS NULL)),
      CHECK (text IS NOT NULL OR (user_id IS NULL AND mentions_bot = 0)),
      CHECK (text IS NULL OR (deleted = 0 AND author_role <> 'other'))
    );

    -- Each file a message shares while the ledger keeps its text, as Slack last described it, with
    -- no address or bytes. A partial file has only its ID, since only files.info has the rest. The
    -- id is the reference the lead reads a file by, and AUTOINCREMENT never hands one out again.
    CREATE TABLE message_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  TEXT NOT NULL,
      ts          TEXT NOT NULL,
      file_id     TEXT NOT NULL,
      whole       INTEGER NOT NULL CHECK (whole IN (0, 1)),
      name        TEXT,
      mime_type   TEXT,
      mode        TEXT,
      size        INTEGER,
      uploader_id TEXT,
      UNIQUE (channel_id, ts, file_id),
      FOREIGN KEY (channel_id, ts) REFERENCES messages (channel_id, ts) ON DELETE CASCADE,
      CHECK (whole = 1 OR COALESCE(name, mime_type, mode, size, uploader_id) IS NULL),
      CHECK (whole = 0 OR (
        mime_type IS NOT NULL AND mode IS NOT NULL AND size IS NOT NULL AND uploader_id IS NOT NULL
      ))
    );

    -- AUTOINCREMENT never hands a seq out again, even once its change is gone, so every new change
    -- comes after every cursor.
    CREATE TABLE changes (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
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

/**
 * Takes version 3's ledger, which kept no files, to version 4's, which describes each file a kept
 * message shares. It keeps its own copy of version 4's table, so a later change to the table can't
 * change what it makes.
 */
export async function addMessageFiles(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE message_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  TEXT NOT NULL,
      ts          TEXT NOT NULL,
      file_id     TEXT NOT NULL,
      whole       INTEGER NOT NULL CHECK (whole IN (0, 1)),
      name        TEXT,
      mime_type   TEXT,
      mode        TEXT,
      size        INTEGER,
      uploader_id TEXT,
      UNIQUE (channel_id, ts, file_id),
      FOREIGN KEY (channel_id, ts) REFERENCES messages (channel_id, ts) ON DELETE CASCADE,
      CHECK (whole = 1 OR COALESCE(name, mime_type, mode, size, uploader_id) IS NULL),
      CHECK (whole = 0 OR (
        mime_type IS NOT NULL AND mode IS NOT NULL AND size IS NOT NULL AND uploader_id IS NOT NULL
      ))
    );
  `);
}

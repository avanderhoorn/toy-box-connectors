export async function initializeOutboxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- An item that may still go out keeps what it says. One that can't may lose it, while a
    -- reply's or publication's row keeps its slot reserved. A reply's row goes with its request,
    -- and so does a post in that request's thread. A post reserves nothing, so its row can go
    -- sooner on its own.
    CREATE TABLE outbox (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'publication', 'post')),
      channel_id TEXT NOT NULL, thread_ts TEXT, series TEXT, scheduled_at INTEGER,
      payload TEXT CHECK (json_valid(payload)), payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'sending', 'sent', 'failed', 'delivery_unknown', 'retracted'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      attempt_started_at INTEGER, next_attempt_at INTEGER,
      reconcile_pass INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_pass BETWEEN 0 AND 2),
      slack_ts TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(link_id, series, scheduled_at),
      CHECK (payload IS NOT NULL OR state NOT IN ('queued', 'sending')),
      CHECK ((kind = 'reply' AND request_id IS NOT NULL AND thread_ts IS NOT NULL
          AND series IS NULL AND scheduled_at IS NULL)
        OR (kind = 'publication' AND request_id IS NULL AND thread_ts IS NULL
          AND series IS NOT NULL AND scheduled_at IS NOT NULL)
        OR (kind = 'post' AND (request_id IS NULL OR thread_ts IS NOT NULL)
          AND series IS NULL AND scheduled_at IS NULL))
    );
    -- A request has one reply, while its thread can hold any number of posts.
    CREATE UNIQUE INDEX outbox_replies ON outbox(request_id) WHERE kind = 'reply';

    -- The files an item shows below its text, in order, while its payload holds what each shows.
    -- They have no text, so they outlast the payload and retract can still delete them.
    CREATE TABLE outbox_files (
      item_id  TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      file_id  TEXT NOT NULL UNIQUE,
      PRIMARY KEY (item_id, position)
    );
    -- The files the bridge uploaded that it owes Slack a delete, until Slack confirms each gone.
    -- They name no link, so unlinking can't drop one.
    CREATE TABLE file_deletions (
      file_id    TEXT PRIMARY KEY,
      due_at     INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL
    );
  `);
}

/**
 * Takes version 2's outbox, which held replies and publications and gave a request one item, to
 * version 3's, which adds posts. SQLite can't change a CHECK or drop a column's UNIQUE, so this
 * copies every item into a new table, carrying its numbering's high-water mark over first so a
 * deleted item's number is never used again. It keeps its own copy of version 3's table, so a
 * later change to the table can't change what it makes.
 */
export async function allowOutboxPosts(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE outbox_new (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'publication', 'post')),
      channel_id TEXT NOT NULL, thread_ts TEXT, series TEXT, scheduled_at INTEGER,
      payload TEXT CHECK (json_valid(payload)), payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'sending', 'sent', 'failed', 'delivery_unknown', 'retracted'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      attempt_started_at INTEGER, next_attempt_at INTEGER,
      reconcile_pass INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_pass BETWEEN 0 AND 2),
      slack_ts TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(link_id, series, scheduled_at),
      CHECK (payload IS NOT NULL OR state NOT IN ('queued', 'sending')),
      CHECK ((kind = 'reply' AND request_id IS NOT NULL AND thread_ts IS NOT NULL
          AND series IS NULL AND scheduled_at IS NULL)
        OR (kind = 'publication' AND request_id IS NULL AND thread_ts IS NULL
          AND series IS NOT NULL AND scheduled_at IS NOT NULL)
        OR (kind = 'post' AND (request_id IS NULL OR thread_ts IS NOT NULL)
          AND series IS NULL AND scheduled_at IS NULL))
    );
    UPDATE sqlite_sequence SET name = 'outbox_new' WHERE name = 'outbox';
    INSERT INTO outbox_new SELECT * FROM outbox;
    DROP TABLE outbox;
    ALTER TABLE outbox_new RENAME TO outbox;
    CREATE UNIQUE INDEX outbox_replies ON outbox(request_id) WHERE kind = 'reply';
  `);
}

/**
 * Takes version 4's outbox, whose items showed only text, to version 5's, which keeps the files an
 * item shows and the deletes the bridge owes Slack. It keeps its own copy of version 5's tables, so
 * a later change to them can't change what it makes.
 */
export async function addOutboxImages(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE outbox_files (
      item_id  TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      file_id  TEXT NOT NULL UNIQUE,
      PRIMARY KEY (item_id, position)
    );
    CREATE TABLE file_deletions (
      file_id    TEXT PRIMARY KEY,
      due_at     INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL
    );
  `);
}

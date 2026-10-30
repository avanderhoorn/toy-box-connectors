export async function initializeOutboxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- A post that may still go out keeps what it says. One that can't may lose it, while its row
    -- keeps its request or publication slot reserved. A reply's row goes with its request, and so
    -- does a post in that request's thread.
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

export async function initializeOutboxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE outbox (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      request_id INTEGER UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'publication')),
      channel_id TEXT NOT NULL, thread_ts TEXT, series TEXT, scheduled_at INTEGER,
      payload TEXT NOT NULL CHECK (json_valid(payload)), payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'sending', 'sent', 'failed', 'delivery_unknown', 'retracted'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      attempt_started_at INTEGER, next_attempt_at INTEGER,
      reconcile_pass INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_pass BETWEEN 0 AND 2),
      slack_ts TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(link_id, series, scheduled_at),
      CHECK ((kind = 'reply' AND request_id IS NOT NULL AND thread_ts IS NOT NULL
          AND series IS NULL AND scheduled_at IS NULL)
        OR (kind = 'publication' AND request_id IS NULL AND thread_ts IS NULL
          AND series IS NOT NULL AND scheduled_at IS NOT NULL))
    );
  `);
}

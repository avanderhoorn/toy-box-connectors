/** Install the tables whose meaning is owned by the outbox. */
export async function initializeOutboxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- id is opaque and carried in message metadata. Replies and publications always carry the
    -- columns their unique index covers, because SQLite treats NULLs as distinct.
    CREATE TABLE outbox (
      id              TEXT PRIMARY KEY,
      number          INTEGER NOT NULL UNIQUE CHECK (typeof(number) = 'integer' AND number > 0),
      link_id         TEXT,
      request_id      INTEGER,
      request_rev     INTEGER
        CHECK (request_rev IS NULL OR (typeof(request_rev) = 'integer' AND request_rev >= 1)),
      approval_id     TEXT,
      kind            TEXT NOT NULL CHECK (kind IN (
        'reply', 'progress', 'publication', 'retract', 'card', 'reaction', 'status'
      )),
      phase           TEXT,
      channel_id      TEXT NOT NULL,
      thread_ts       TEXT,
      publication_key TEXT,
      replaces        TEXT,
      payload         TEXT NOT NULL CHECK (json_valid(payload)),
      payload_hash    TEXT NOT NULL,
      metadata_ok     INTEGER CHECK (metadata_ok IS NULL OR metadata_ok IN (0, 1)),
      state           TEXT NOT NULL CHECK (state IN (
        'queued', 'sending', 'sent', 'failed', 'delivery_unknown', 'stray',
        'superseded', 'retracted', 'dropped', 'cancelled', 'skipped'
      )),
      attempts        INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
      next_attempt_at INTEGER,
      slack_ts        TEXT,
      error           TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      CHECK ((phase IS NOT NULL) = (kind IN ('reply', 'card'))),
      CHECK (kind <> 'reply' OR phase IN ('final', 'follow_up')),
      CHECK (kind <> 'card' OR phase IN ('post', 'update')),
      CHECK (kind <> 'reply' OR (request_id IS NOT NULL AND request_rev IS NOT NULL)),
      CHECK (kind <> 'publication' OR (link_id IS NOT NULL AND publication_key IS NOT NULL))
    );

    CREATE UNIQUE INDEX outbox_one_final
      ON outbox(request_id, request_rev)
      WHERE kind = 'reply' AND phase = 'final'
        AND state NOT IN ('failed', 'dropped', 'superseded', 'cancelled');

    CREATE UNIQUE INDEX outbox_one_publication
      ON outbox(link_id, publication_key)
      WHERE state IN ('queued', 'sending', 'sent', 'delivery_unknown', 'stray', 'retracted', 'skipped');

    CREATE TABLE rate_limits (
      method          TEXT PRIMARY KEY,
      next_attempt_at INTEGER NOT NULL
    );
  `);
}

/** Install the tables whose meaning is owned by the outbox. */
export async function initializeOutboxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- id is opaque and carried in message metadata. request_rev is the revision the lead read, from
    -- reply --revision. Replies and publications always carry the columns their unique index
    -- covers, because SQLite treats NULLs as distinct. evidence says how we know a post landed.
    CREATE TABLE outbox (
      id              TEXT PRIMARY KEY,
      number          INTEGER NOT NULL UNIQUE CHECK (typeof(number) = 'integer' AND number > 0),
      link_id         TEXT,
      request_id      INTEGER,
      approval_id     TEXT,
      request_rev     INTEGER
        CHECK (request_rev IS NULL OR (typeof(request_rev) = 'integer' AND request_rev >= 1)),
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
      evidence        TEXT CHECK (evidence IS NULL OR evidence IN ('response', 'metadata', 'text')),
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
  `);
}

/** Version 2: preserve each attempt's clock and a post slot shared by every link and card. */
export async function addOutboxDeliverySchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    ALTER TABLE outbox ADD COLUMN attempt_method TEXT CHECK (attempt_method IS NULL OR attempt_method IN (
      'chat.postMessage', 'chat.update', 'chat.delete', 'reactions.add', 'reactions.remove',
      'assistant.threads.setStatus'
    ));
    ALTER TABLE outbox ADD COLUMN attempt_started_at INTEGER
      CHECK (attempt_started_at IS NULL OR (
        typeof(attempt_started_at) = 'integer' AND attempt_started_at >= 0
      ));
    ALTER TABLE outbox ADD COLUMN reconcile_pass INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(reconcile_pass) = 'integer' AND reconcile_pass BETWEEN 0 AND 3);

    -- Older items have no attempt clock. Queue time is a conservative lower bound: an
    -- updated_at recorded after acceptance could exclude the very message we're finding.
    UPDATE outbox SET
      attempt_started_at = created_at,
      next_attempt_at = CASE WHEN state = 'delivery_unknown'
        THEN COALESCE(next_attempt_at, created_at + 10000) ELSE next_attempt_at END
      WHERE attempts > 0 OR state IN ('sending', 'delivery_unknown');

    CREATE TABLE outbox_channels (
      channel_id   TEXT PRIMARY KEY,
      next_post_at INTEGER NOT NULL
        CHECK (typeof(next_post_at) = 'integer' AND next_post_at >= 0)
    );

    INSERT INTO outbox_channels (channel_id, next_post_at)
      SELECT channel_id, MAX(updated_at) + 1000 FROM outbox
      WHERE attempts > 0 OR state IN ('sending', 'sent', 'delivery_unknown', 'stray', 'retracted')
      GROUP BY channel_id;
  `);
}

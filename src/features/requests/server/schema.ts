/** Install the tables whose meaning is owned by Requests. */
export async function initializeRequestSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- input_rev counts substantive changes, and served_rev is the revision the lead was last shown.
    CREATE TABLE requests (
      id                INTEGER PRIMARY KEY,
      link_id           TEXT NOT NULL,
      channel_id        TEXT NOT NULL,
      root_ts           TEXT NOT NULL,
      source_ts         TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      reason            TEXT NOT NULL CHECK (reason IN ('mention', 'follow_up', 'channel_root')),
      state             TEXT NOT NULL CHECK (state IN (
        'open', 'seen', 'in_progress', 'answering', 'answered', 'dismissed', 'cancelled', 'expired'
      )),
      input_rev         INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(input_rev) = 'integer' AND input_rev >= 1),
      input_hash        TEXT NOT NULL,
      served_rev        INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(served_rev) = 'integer' AND served_rev >= 0),
      attention         TEXT
        CHECK (attention IS NULL OR attention IN ('updated', 'reply_failed', 'source_unverified')),
      held_at           INTEGER,
      hold_reason       TEXT,
      late              INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
      created_at        INTEGER NOT NULL,
      changed_at        INTEGER NOT NULL,
      seen_at           INTEGER,
      touched_at        INTEGER,
      reminded_at       INTEGER,
      progress_ts       TEXT,
      expires_at        INTEGER NOT NULL,
      closed_reason     TEXT,
      CHECK (served_rev <= input_rev)
    );

    CREATE TABLE request_messages (
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (request_id, channel_id, ts)
    );
  `);
}

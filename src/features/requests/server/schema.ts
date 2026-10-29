/** Install the tables whose meaning is owned by Requests. */
export async function initializeRequestSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- AUTOINCREMENT never hands a request's number out again, even once its row is gone, so a
    -- number the lead still holds can't name a newer request. attention is what the lead must read
    -- before it can answer or dismiss the request, and reading clears it.
    CREATE TABLE requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id           TEXT NOT NULL,
      channel_id        TEXT NOT NULL,
      root_ts           TEXT NOT NULL,
      source_ts         TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      reason            TEXT NOT NULL CHECK (reason IN ('mention', 'follow_up', 'channel_root')),
      state             TEXT NOT NULL CHECK (state IN (
        'open', 'seen', 'answering', 'answered', 'dismissed', 'cancelled', 'expired'
      )),
      attention         TEXT CHECK (attention IN ('updated', 'reply_failed')),
      created_at        INTEGER NOT NULL,
      changed_at        INTEGER NOT NULL,
      touched_at        INTEGER,
      closed_reason     TEXT,
      CHECK (attention IS NULL OR state = 'seen'),
      CHECK ((closed_reason IS NOT NULL) = (state IN ('dismissed', 'cancelled')))
    );

    CREATE INDEX requests_thread ON requests(link_id, root_ts);

    CREATE TABLE request_messages (
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (request_id, channel_id, ts)
    );

    -- A message belongs to at most one request.
    CREATE UNIQUE INDEX request_messages_one_request ON request_messages(channel_id, ts);
  `);
}

/** Install the tables whose meaning is owned by Requests. */
export async function initializeRequestSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- input_rev counts substantive changes, and served_rev is the revision the lead was last shown.
    -- attention is what the lead must read, and reading clears it. source_unverified_at holds the
    -- request's replies until repair re-reads its source, and never wakes the lead.
    CREATE TABLE requests (
      id                   INTEGER PRIMARY KEY,
      link_id              TEXT NOT NULL,
      channel_id           TEXT NOT NULL,
      root_ts              TEXT NOT NULL,
      source_ts            TEXT NOT NULL,
      requester_user_id    TEXT NOT NULL,
      reason               TEXT NOT NULL CHECK (reason IN ('mention', 'follow_up', 'channel_root')),
      state                TEXT NOT NULL CHECK (state IN (
        'open', 'seen', 'in_progress', 'answering', 'answered', 'dismissed', 'cancelled', 'expired'
      )),
      input_rev            INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(input_rev) = 'integer' AND input_rev >= 1),
      input_hash           TEXT NOT NULL,
      served_rev           INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(served_rev) = 'integer' AND served_rev >= 0),
      attention            TEXT
        CHECK (attention IS NULL OR attention IN ('updated', 'reply_failed')),
      source_unverified_at INTEGER,
      held_at              INTEGER,
      hold_reason          TEXT,
      late                 INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
      created_at           INTEGER NOT NULL,
      changed_at           INTEGER NOT NULL,
      seen_at              INTEGER,
      touched_at           INTEGER,
      reminded_at          INTEGER,
      progress_ts          TEXT,
      expires_at           INTEGER NOT NULL,
      closed_reason        TEXT,
      CHECK (served_rev <= input_rev),
      CHECK (state IN ('cancelled', 'expired') OR (seen_at IS NULL) = (state = 'open')),
      CHECK ((held_at IS NULL) = (hold_reason IS NULL)),
      CHECK (held_at IS NULL OR state IN ('seen', 'in_progress')),
      CHECK (attention IS NULL OR state IN ('seen', 'in_progress', 'answering')),
      CHECK (source_unverified_at IS NULL OR state IN ('open', 'seen', 'in_progress', 'answering')),
      CHECK ((closed_reason IS NOT NULL) = (state IN ('dismissed', 'cancelled')))
    );

    -- A requester has at most one active request per thread, which their later messages join.
    CREATE UNIQUE INDEX requests_one_active ON requests(link_id, requester_user_id, root_ts)
      WHERE state IN ('open', 'seen', 'in_progress', 'answering');

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

/**
 * Version 4: never hand a request's number out again, even after its row is gone, and remember
 * when inbox told the lead that a request it read was cancelled or expired, so it tells it once.
 *
 * Only a rebuild adds AUTOINCREMENT. Migrations run with foreign keys on, which `PRAGMA
 * foreign_keys` can't turn off inside their transaction, so dropping requests deletes every request
 * message through the cascade. Both tables are copied aside before either is dropped.
 */
export async function rebuildRequestSchema(db: Bun.SQL): Promise<void> {
  const columns = `
    id, link_id, channel_id, root_ts, source_ts, requester_user_id, reason, state, input_rev,
    input_hash, served_rev, attention, source_unverified_at, held_at, hold_reason, late, created_at,
    changed_at, seen_at, touched_at, reminded_at, progress_ts, expires_at, closed_reason
  `;
  await db.unsafe(`
    CREATE TEMP TABLE requests_before AS SELECT * FROM requests;
    CREATE TEMP TABLE request_messages_before AS SELECT * FROM request_messages;
    DROP TABLE request_messages;
    DROP TABLE requests;

    -- input_rev counts substantive changes, and served_rev is the revision the lead was last shown.
    -- attention is what the lead must read, and reading clears it. source_unverified_at holds the
    -- request's replies until repair re-reads its source, and never wakes the lead.
    -- closed_reported_at is when inbox told the lead that a request it read ended unanswered.
    CREATE TABLE requests (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id              TEXT NOT NULL,
      channel_id           TEXT NOT NULL,
      root_ts              TEXT NOT NULL,
      source_ts            TEXT NOT NULL,
      requester_user_id    TEXT NOT NULL,
      reason               TEXT NOT NULL CHECK (reason IN ('mention', 'follow_up', 'channel_root')),
      state                TEXT NOT NULL CHECK (state IN (
        'open', 'seen', 'in_progress', 'answering', 'answered', 'dismissed', 'cancelled', 'expired'
      )),
      input_rev            INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(input_rev) = 'integer' AND input_rev >= 1),
      input_hash           TEXT NOT NULL,
      served_rev           INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(served_rev) = 'integer' AND served_rev >= 0),
      attention            TEXT
        CHECK (attention IS NULL OR attention IN ('updated', 'reply_failed')),
      source_unverified_at INTEGER,
      held_at              INTEGER,
      hold_reason          TEXT,
      late                 INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
      created_at           INTEGER NOT NULL,
      changed_at           INTEGER NOT NULL,
      seen_at              INTEGER,
      touched_at           INTEGER,
      reminded_at          INTEGER,
      progress_ts          TEXT,
      expires_at           INTEGER NOT NULL,
      closed_reason        TEXT,
      closed_reported_at   INTEGER,
      CHECK (served_rev <= input_rev),
      CHECK (state IN ('cancelled', 'expired') OR (seen_at IS NULL) = (state = 'open')),
      CHECK ((held_at IS NULL) = (hold_reason IS NULL)),
      CHECK (held_at IS NULL OR state IN ('seen', 'in_progress')),
      CHECK (attention IS NULL OR state IN ('seen', 'in_progress', 'answering')),
      CHECK (source_unverified_at IS NULL OR state IN ('open', 'seen', 'in_progress', 'answering')),
      CHECK ((closed_reason IS NOT NULL) = (state IN ('dismissed', 'cancelled'))),
      CHECK (closed_reported_at IS NULL OR (state IN ('cancelled', 'expired') AND seen_at IS NOT NULL))
    );

    -- A requester has at most one active request per thread, which their later messages join.
    CREATE UNIQUE INDEX requests_one_active ON requests(link_id, requester_user_id, root_ts)
      WHERE state IN ('open', 'seen', 'in_progress', 'answering');

    CREATE TABLE request_messages (
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (request_id, channel_id, ts)
    );

    -- A message belongs to at most one request.
    CREATE UNIQUE INDEX request_messages_one_request ON request_messages(channel_id, ts);

    INSERT INTO requests (${columns}) SELECT ${columns} FROM requests_before;
    INSERT INTO request_messages (request_id, channel_id, ts)
      SELECT request_id, channel_id, ts FROM request_messages_before;
    DROP TABLE requests_before;
    DROP TABLE request_messages_before;
  `);
}

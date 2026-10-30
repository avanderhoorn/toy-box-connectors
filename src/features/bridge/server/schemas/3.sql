-- Schema version 3, which 0.3.0 shipped, as the bridge creates it. Owners' bridge.db files have
-- these tables, so this never changes, and a change to a table records the next version beside it.

CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  team_id TEXT NOT NULL, app_id TEXT NOT NULL, bot_id TEXT NOT NULL, bot_user_id TEXT NOT NULL,
  enterprise_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'auth_failed', 'uninstalled')),
  connected_at INTEGER
);

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT, real_name TEXT
);

CREATE TABLE user_aliases (
  alias_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE links (
  id                  TEXT PRIMARY KEY,
  toybox_channel_id   TEXT NOT NULL UNIQUE,
  slack_channel_id    TEXT NOT NULL UNIQUE,
  request_mode        TEXT NOT NULL DEFAULT 'mention' CHECK (request_mode IN ('mention', 'all')),
  observe             TEXT NOT NULL DEFAULT 'requesters'
    CHECK (observe IN ('requesters', 'channel')),
  status              TEXT NOT NULL CHECK (status IN ('active', 'paused', 'suspended')),
  status_reason       TEXT,
  approved_audience   TEXT NOT NULL CHECK (json_valid(approved_audience)),
  linked_at_ts        TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE allowlist (
  link_id  TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (link_id, user_id)
);

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

CREATE TABLE changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('new', 'edited', 'deleted'))
);

CREATE TABLE cursors (
  link_id            TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  through_seq        INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(through_seq) = 'integer' AND through_seq >= 0),
  served_through_seq INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(served_through_seq) = 'integer' AND served_through_seq >= 0),
  CHECK (through_seq <= served_through_seq)
);

CREATE TABLE gaps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER NOT NULL
);

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

CREATE UNIQUE INDEX request_messages_one_request ON request_messages(channel_id, ts);

CREATE TABLE wakes (
  id      INTEGER PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ran', 'missing', 'failed', 'refused'))
);

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

CREATE UNIQUE INDEX outbox_replies ON outbox(request_id) WHERE kind = 'reply';

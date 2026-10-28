/** Install the tables whose meaning is owned by Wakes. */
export async function initializeWakeSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- restore_waiting_for and restore_wake_at keep the waiting status the last wake cleared.
    CREATE TABLE wake_state (
      link_id             TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
      last_wake_at        INTEGER,
      last_inbox_at       INTEGER,
      wakes_since_inbox   INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(wakes_since_inbox) = 'integer' AND wakes_since_inbox >= 0),
      retry_at            INTEGER,
      blocked_reason      TEXT,
      restore_waiting_for TEXT,
      restore_wake_at     INTEGER
    );

    CREATE TABLE wakes (
      id          INTEGER PRIMARY KEY,
      link_id     TEXT,
      approval_id TEXT,
      at          INTEGER NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('requests', 'reminder', 'setup', 'catch_up')),
      outcome     TEXT NOT NULL CHECK (outcome IN ('ran', 'missing', 'failed', 'refused'))
    );
  `);
}

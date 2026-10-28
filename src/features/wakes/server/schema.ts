/** Install the tables whose meaning is owned by Wakes. */
export async function initializeWakeSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE wake_state (
      link_id           TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
      last_wake_at      INTEGER,
      last_inbox_at     INTEGER,
      wakes_since_inbox INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(wakes_since_inbox) = 'integer' AND wakes_since_inbox >= 0),
      retry_at          INTEGER,
      blocked_reason    TEXT
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

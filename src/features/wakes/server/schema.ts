/** Install the tables whose meaning is owned by Wakes. */
export async function initializeWakeSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- blocked_reason holds only what a run's outcome blocks. The rest is derived from the link.
    CREATE TABLE wake_state (
      link_id           TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
      last_wake_at      INTEGER,
      last_inbox_at     INTEGER,
      wakes_since_inbox INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(wakes_since_inbox) = 'integer' AND wakes_since_inbox >= 0),
      retry_at          INTEGER,
      blocked_reason    TEXT CHECK (blocked_reason IS NULL OR blocked_reason = 'refused')
    );

    -- Every run the bridge attempted. A catch-up run names the period it ran for.
    CREATE TABLE wakes (
      id              INTEGER PRIMARY KEY,
      link_id         TEXT NOT NULL,
      at              INTEGER NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('requests', 'reminder', 'catch_up')),
      publication_key TEXT,
      outcome         TEXT NOT NULL CHECK (outcome IN ('ran', 'missing', 'failed', 'refused')),
      CHECK ((publication_key IS NOT NULL) = (kind = 'catch_up'))
    );
  `);
}

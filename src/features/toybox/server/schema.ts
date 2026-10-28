/** Install the tables whose meaning is owned by the Toy Box client. */
export async function initializeToyBoxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- lead_state and waiting_* are the lead's presence as last seen. restore_* keep what it waited
    -- for before its current turn. IS keeps a NULL lead_state from passing for 'waiting'.
    CREATE TABLE toybox_streams (
      toybox_channel_id TEXT PRIMARY KEY,
      revision          INTEGER
        CHECK (revision IS NULL OR (typeof(revision) = 'integer' AND revision >= 0)),
      owner_spoke_at    INTEGER,
      provider          TEXT,
      lead_state        TEXT
        CHECK (lead_state IS NULL OR lead_state IN ('working', 'waiting', 'idle')),
      waiting_for       TEXT,
      waiting_wake_at   INTEGER,
      restore_for       TEXT,
      restore_wake_at   INTEGER,
      CHECK ((waiting_for IS NOT NULL) = (lead_state IS 'waiting')),
      CHECK (restore_for IS NULL OR lead_state IS 'working'),
      CHECK (waiting_wake_at IS NULL OR waiting_for IS NOT NULL),
      CHECK (restore_wake_at IS NULL OR restore_for IS NOT NULL)
    );
  `);
}

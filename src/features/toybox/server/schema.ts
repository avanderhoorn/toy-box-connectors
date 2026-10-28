/** Install the tables whose meaning is owned by the Toy Box client. */
export async function initializeToyBoxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- restore_for and restore_wake_at keep the waiting status the lead had before its current turn.
    CREATE TABLE toybox_streams (
      toybox_channel_id TEXT PRIMARY KEY,
      revision          INTEGER
        CHECK (revision IS NULL OR (typeof(revision) = 'integer' AND revision >= 0)),
      owner_spoke_at    INTEGER,
      provider          TEXT,
      lead_state        TEXT,
      waiting_for       TEXT,
      waiting_wake_at   INTEGER,
      restore_for       TEXT,
      restore_wake_at   INTEGER
    );
  `);
}

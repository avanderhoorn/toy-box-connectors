/** Install the tables whose meaning is owned by the Toy Box client. */
export async function initializeToyBoxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE toybox_streams (
      toybox_channel_id TEXT PRIMARY KEY,
      revision          INTEGER
        CHECK (revision IS NULL OR (typeof(revision) = 'integer' AND revision >= 0)),
      owner_spoke_at    INTEGER,
      provider          TEXT
    );
  `);
}

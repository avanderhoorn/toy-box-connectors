/** Install the tables whose meaning is owned by Wakes. */
export async function initializeWakeSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- Every routine run the bridge attempted for a link. Each pass prunes what no decision reads:
    -- runs over an hour old, except the link's latest and its latest few that landed.
    CREATE TABLE wakes (
      id      INTEGER PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      at      INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ran', 'missing', 'failed', 'refused'))
    );
  `);
}

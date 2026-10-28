/** Install the tables whose meaning is owned by Links. */
export async function initializeLinkSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- posted_* say who posted the right code, in which message and when. A claim voided after that
    -- keeps them. void_reason is expired, exhausted, replaced or the admission check's refusal.
    CREATE TABLE claims (
      id                INTEGER PRIMARY KEY,
      code_hash         TEXT NOT NULL,
      state             TEXT NOT NULL
        CHECK (state IN ('live', 'posted', 'admitted', 'confirmed', 'declined', 'void')),
      failed_attempts   INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(failed_attempts) = 'integer' AND failed_attempts >= 0),
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      posted_by         TEXT,
      posted_channel_id TEXT,
      posted_ts         TEXT,
      posted_at         INTEGER,
      decided_at        INTEGER,
      void_reason       TEXT,
      CHECK ((posted_channel_id IS NULL) = (posted_by IS NULL)
        AND (posted_ts IS NULL) = (posted_by IS NULL)
        AND (posted_at IS NULL) = (posted_by IS NULL)),
      CHECK (state = 'void'
        OR (posted_by IS NOT NULL) = (state IN ('posted', 'admitted', 'confirmed', 'declined'))),
      CHECK ((decided_at IS NOT NULL) = (state IN ('confirmed', 'declined', 'void'))),
      CHECK ((void_reason IS NOT NULL) = (state = 'void'))
    );

    -- Every open claim indexes the same constant, so at most one can be open.
    CREATE UNIQUE INDEX claims_one_open ON claims((1)) WHERE state IN ('live', 'posted', 'admitted');

    -- approved_audience holds both channels' audiences as the owner last approved them, which every
    -- later read of either channel is judged against.
    CREATE TABLE links (
      id                  TEXT PRIMARY KEY,
      toybox_channel_id   TEXT NOT NULL UNIQUE,
      slack_channel_id    TEXT NOT NULL UNIQUE,
      publish_channel_id  TEXT NOT NULL,
      request_mode        TEXT NOT NULL DEFAULT 'mention' CHECK (request_mode IN ('mention', 'all')),
      observe             TEXT NOT NULL DEFAULT 'requesters'
        CHECK (observe IN ('requesters', 'channel')),
      status              TEXT NOT NULL CHECK (status IN ('active', 'paused', 'suspended')),
      status_reason       TEXT,
      approved_audience   TEXT NOT NULL CHECK (json_valid(approved_audience)),
      requests_routine_id TEXT NOT NULL,
      routine_state       TEXT NOT NULL CHECK (routine_state IN ('present', 'drifted', 'missing')),
      linked_at_ts        TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    -- A series owes catch-ups only for runs scheduled at or after registered_at, which a new
    -- schedule moves forward.
    CREATE TABLE link_routines (
      link_id       TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      series        TEXT NOT NULL,
      routine_id    TEXT NOT NULL,
      routine_state TEXT NOT NULL CHECK (routine_state IN ('present', 'drifted', 'missing')),
      period        TEXT NOT NULL CHECK (period IN ('day', 'week')),
      schedule      TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY (link_id, series)
    );

    -- The owner is implicit.
    CREATE TABLE allowlist (
      link_id  TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL,
      label    TEXT,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (link_id, user_id)
    );

    -- id is opaque and the only value a button carries. link_id is NULL for a new link. patch holds
    -- only the fields that change, and read_set holds every value the approval was decided against.
    -- An approval can expire or go stale before or after the owner decides it.
    CREATE TABLE approvals (
      id                TEXT PRIMARY KEY,
      number            INTEGER NOT NULL UNIQUE CHECK (typeof(number) = 'integer' AND number > 0),
      toybox_channel_id TEXT NOT NULL,
      link_id           TEXT,
      action            TEXT NOT NULL CHECK (action IN ('link', 'allow', 'set', 'resume', 'owner')),
      patch             TEXT NOT NULL CHECK (json_valid(patch)),
      read_set          TEXT NOT NULL CHECK (json_valid(read_set)),
      owner_user_id     TEXT NOT NULL,
      card_channel_id   TEXT NOT NULL,
      card_ts           TEXT,
      state             TEXT NOT NULL
        CHECK (state IN ('pending', 'approved', 'applied', 'rejected', 'expired', 'stale')),
      stale_reason      TEXT,
      applied_at        INTEGER,
      decided_by        TEXT,
      decided_at        INTEGER,
      reported_at       INTEGER,
      created_by        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      CHECK ((stale_reason IS NOT NULL) = (state = 'stale')),
      CHECK ((applied_at IS NOT NULL) = (state = 'applied')),
      CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
      CHECK (state IN ('expired', 'stale')
        OR (decided_by IS NOT NULL) = (state IN ('approved', 'applied', 'rejected')))
    );

    -- IDs only, never message text.
    CREATE TABLE audit (
      id          INTEGER PRIMARY KEY,
      at          INTEGER NOT NULL,
      actor       TEXT NOT NULL CHECK (actor IN ('lead', 'member', 'operator', 'owner', 'bridge')),
      action      TEXT NOT NULL,
      link_id     TEXT,
      approval_id TEXT,
      subject     TEXT
    );
  `);
}

/**
 * Version 3: number every approval after every approval there has ever been. A card and the lead
 * call it a4, and a purge used to let the next approval take a number someone still held.
 * Rebuilding the table makes the number its AUTOINCREMENT key, which SQLite never hands out again,
 * and keeps every approval with the number it had.
 */
export async function numberApprovalsOnce(db: Bun.SQL): Promise<void> {
  const columns = `
    id, number, toybox_channel_id, link_id, action, patch, read_set, owner_user_id,
    card_channel_id, card_ts, state, stale_reason, applied_at, decided_by, decided_at, reported_at,
    created_by, created_at, expires_at
  `;
  await db.unsafe(`
    CREATE TABLE numbered_approvals (
      id                TEXT NOT NULL UNIQUE,
      number            INTEGER PRIMARY KEY AUTOINCREMENT CHECK (number > 0),
      toybox_channel_id TEXT NOT NULL,
      link_id           TEXT,
      action            TEXT NOT NULL CHECK (action IN ('link', 'allow', 'set', 'resume', 'owner')),
      patch             TEXT NOT NULL CHECK (json_valid(patch)),
      read_set          TEXT NOT NULL CHECK (json_valid(read_set)),
      owner_user_id     TEXT NOT NULL,
      card_channel_id   TEXT NOT NULL,
      card_ts           TEXT,
      state             TEXT NOT NULL
        CHECK (state IN ('pending', 'approved', 'applied', 'rejected', 'expired', 'stale')),
      stale_reason      TEXT,
      applied_at        INTEGER,
      decided_by        TEXT,
      decided_at        INTEGER,
      reported_at       INTEGER,
      created_by        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      CHECK ((stale_reason IS NOT NULL) = (state = 'stale')),
      CHECK ((applied_at IS NOT NULL) = (state = 'applied')),
      CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
      CHECK (state IN ('expired', 'stale')
        OR (decided_by IS NOT NULL) = (state IN ('approved', 'applied', 'rejected')))
    );

    INSERT INTO numbered_approvals (${columns}) SELECT ${columns} FROM approvals;
    DROP TABLE approvals;
    ALTER TABLE numbered_approvals RENAME TO approvals;
  `);
}

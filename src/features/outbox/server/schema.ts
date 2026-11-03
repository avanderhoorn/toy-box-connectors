import { z } from "zod";

export async function initializeOutboxSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- An item that may still go out keeps what it says. One that can't may lose it, while a
    -- reply's or publication's row keeps its slot reserved. A reply's row goes with its request,
    -- and so does a post in that request's thread. A post reserves nothing, so its row can go
    -- sooner on its own.
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
    -- A request has one reply, while its thread can hold any number of posts.
    CREATE UNIQUE INDEX outbox_replies ON outbox(request_id) WHERE kind = 'reply';

    -- The files an item shows below its text, in order, while its payload holds what each shows.
    -- They have no text, so they outlast the payload and retract can still delete them.
    CREATE TABLE outbox_files (
      item_id  TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      file_id  TEXT NOT NULL UNIQUE,
      PRIMARY KEY (item_id, position)
    );
    -- The files the bridge uploaded that it owes Slack a delete, until Slack confirms each gone.
    -- They name no link, so unlinking can't drop one.
    CREATE TABLE file_deletions (
      file_id    TEXT PRIMARY KEY,
      due_at     INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL
    );
    -- What a request's message in Slack should show, until Slack confirms it does. One row per
    -- message, so the newest display replaces an older one. It names no link, so unlinking can't
    -- drop the 👀 it owes.
    CREATE TABLE reaction_displays (
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      shows      TEXT NOT NULL CHECK (shows IN ('eyes', 'runner', 'bare')),
      due_at     INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      owed_at    INTEGER NOT NULL,
      PRIMARY KEY (channel_id, ts)
    );
  `);
}

/**
 * Takes version 2's outbox, which held replies and publications and gave a request one item, to
 * version 3's, which adds posts. SQLite can't change a CHECK or drop a column's UNIQUE, so this
 * copies every item into a new table, carrying its numbering's high-water mark over first so a
 * deleted item's number is never used again. It keeps its own copy of version 3's table, so a
 * later change to the table can't change what it makes.
 */
export async function allowOutboxPosts(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE outbox_new (
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
    UPDATE sqlite_sequence SET name = 'outbox_new' WHERE name = 'outbox';
    INSERT INTO outbox_new SELECT * FROM outbox;
    DROP TABLE outbox;
    ALTER TABLE outbox_new RENAME TO outbox;
    CREATE UNIQUE INDEX outbox_replies ON outbox(request_id) WHERE kind = 'reply';
  `);
}

/**
 * Takes version 4's outbox, whose items showed only text, to version 5's, which keeps the files an
 * item shows and the deletes the bridge owes Slack. It keeps its own copy of version 5's tables, so
 * a later change to them can't change what it makes.
 */
export async function addOutboxImages(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE outbox_files (
      item_id  TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      file_id  TEXT NOT NULL UNIQUE,
      PRIMARY KEY (item_id, position)
    );
    CREATE TABLE file_deletions (
      file_id    TEXT PRIMARY KEY,
      due_at     INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL
    );
  `);
}

/**
 * Takes version 6's outbox, which kept the reactions it owed in memory, to version 7's, which keeps
 * what each message should show. It keeps its own copy of version 7's table, so a later change to
 * it can't change what it makes.
 */
export async function addReactionDisplays(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE reaction_displays (
      channel_id TEXT NOT NULL,
      ts         TEXT NOT NULL,
      shows      TEXT NOT NULL CHECK (shows IN ('eyes', 'runner', 'bare')),
      due_at     INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      owed_at    INTEGER NOT NULL,
      PRIMARY KEY (channel_id, ts)
    );
  `);
}

/** What version 5 kept for an item: the message its text rendered to, and each image's alt text. */
const renderedPayloadSchema = z.object({
  text: z.string(),
  blocks: z.tuple([z.object({ text: z.string() })]),
  images: z.array(z.object({ alt: z.string() })).default([]),
});

/**
 * Takes version 5's outbox, whose items kept the message their text rendered to, to version 6's,
 * which keeps what the lead asked for and renders it as it's sent. Only an item that may still go
 * out keeps what it says, so only it changes, and it keeps its hash, which names what Slack may
 * already show. Its text was rendered, and rendering that again changes nothing, so it goes out as
 * it would have. One this can't read stays as it was, and sending refuses it.
 */
export async function renderOutboxAtSend(db: Bun.SQL): Promise<void> {
  const items = await db<{ id: string; payload: string }[]>`
    SELECT id, payload FROM outbox WHERE state IN ('queued', 'sending')
  `;
  for (const item of items) {
    const stored = renderedPayloadSchema.safeParse(JSON.parse(item.payload));
    if (!stored.success) continue;
    const { text, blocks, images } = stored.data;
    const block = blocks[0].text;
    // A post's block opens with a line of the people it mentions, which its text leaves out.
    const line = block === text ? "" : block.slice(0, -text.length - 2);
    const mentions = line ? line.split(" ").map((mention) => mention.slice(2, -1)) : [];
    const named = mentions.map((id) => `<@${id}>`).join(" ");
    if (block !== (named ? `${named}\n\n${text}` : text)) continue;
    const payload = JSON.stringify({ text, mentions, images });
    await db`UPDATE outbox SET payload = ${payload} WHERE id = ${item.id}`;
  }
}

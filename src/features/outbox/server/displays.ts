// The reactions the bridge owes Slack on requests' messages.
//
// Each row says what one message should show, written in the transaction that changes the request,
// until Slack confirms it does. A newer display replaces an older one and starts it over, so it
// repairs whatever an earlier one missed. A row names no link, so unlinking can't drop one.

import type { Display } from "../model/reactions";

/** A request, as far as its message in Slack goes. */
export type MarkedRequest = { channelId: string; sourceTs: string };

/** A display the bridge owes a message. */
export type OwedDisplay = MarkedRequest & {
  shows: Display;
  attempts: number;
  owedAt: number;
};

/** Owes each request's message `shows`, due at once. */
export async function oweDisplays(
  tx: Bun.SQL,
  requests: readonly MarkedRequest[],
  shows: Display,
  now: number,
): Promise<void> {
  for (const { channelId, sourceTs } of requests)
    await tx`
      INSERT INTO reaction_displays (channel_id, ts, shows, due_at, owed_at)
      VALUES (${channelId}, ${sourceTs}, ${shows}, ${now}, ${now})
      ON CONFLICT (channel_id, ts) DO UPDATE SET
        shows = excluded.shows, due_at = excluded.due_at, attempts = 0, owed_at = excluded.owed_at
    `;
}

/** The displays due by `now`, soonest first. */
export async function readDueDisplays(sql: Bun.SQL, now: number): Promise<OwedDisplay[]> {
  const rows = await sql<
    { channel_id: string; ts: string; shows: Display; attempts: number; owed_at: number }[]
  >`
    SELECT channel_id, ts, shows, attempts, owed_at FROM reaction_displays WHERE due_at <= ${now}
    ORDER BY due_at, channel_id, ts LIMIT 100
  `;
  return rows.map((row) => ({
    channelId: row.channel_id,
    sourceTs: row.ts,
    shows: row.shows,
    attempts: row.attempts,
    owedAt: row.owed_at,
  }));
}

/**
 * Settles a display Slack now shows, or one the bridge gave up on. A display owed meanwhile stays,
 * since the calls made didn't bring the message to it.
 */
export async function forgetDisplay(tx: Bun.SQL, owed: OwedDisplay): Promise<void> {
  await tx`
    DELETE FROM reaction_displays
    WHERE channel_id = ${owed.channelId} AND ts = ${owed.sourceTs} AND shows = ${owed.shows}
  `;
}

/** Owes again, at `dueAt`, a display Slack didn't answer for, unless a newer one replaced it. */
export async function deferDisplay(tx: Bun.SQL, owed: OwedDisplay, dueAt: number): Promise<void> {
  await tx`
    UPDATE reaction_displays SET attempts = attempts + 1, due_at = ${dueAt}
    WHERE channel_id = ${owed.channelId} AND ts = ${owed.sourceTs} AND shows = ${owed.shows}
  `;
}

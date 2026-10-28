// What the wake scheduler reads and records.
//
// A pass reads every link's requests and run log in one read, so the two agree. The log keeps
// failures as well as landed runs, so a restart keeps a link's backoff and `status` can say why
// the lead wasn't woken.

import { STALL_AFTER, type LinkWakeState, type WakeRequest, type WakeRun } from "@wakes/model";

/** A link, the Toy Box channel its lead leads, and what its wake decision reads. */
export type LinkWakes = LinkWakeState & { id: string; channelId: string };

const HOUR = 60 * 60_000;

/** Every link with what its wake decision reads. */
export async function readLinkWakes(sql: Bun.SQL): Promise<LinkWakes[]> {
  const links = await sql<
    { id: string; channelId: string; status: string; suspendedAt: number | null }[]
  >`
    SELECT id, toybox_channel_id AS channelId, status,
      CASE WHEN status = 'suspended' THEN updated_at END AS suspendedAt
    FROM links ORDER BY id
  `;
  const requests = await sql<(WakeRequest & { linkId: string })[]>`
    SELECT link_id AS linkId, state, attention, changed_at AS changedAt, touched_at AS touchedAt
    FROM requests WHERE state IN ('open', 'seen')
  `;
  const runs = await sql<(WakeRun & { linkId: string })[]>`
    SELECT link_id AS linkId, at, outcome FROM wakes ORDER BY id DESC
  `;
  return links.map(({ status, ...link }) => ({
    ...link,
    active: status === "active",
    requests: ofLink(requests, link.id),
    runs: ofLink(runs, link.id),
  }));
}

/** Records that Toy Box answered a run for the link's lead started at `at` with `outcome`. */
export async function recordWake(
  transaction: Bun.SQL,
  linkId: string,
  at: number,
  outcome: WakeRun["outcome"],
): Promise<void> {
  // A link removed while its run was in flight has nothing left to record it for.
  await transaction`
    INSERT INTO wakes (link_id, at, outcome)
    SELECT ${linkId}, ${at}, ${outcome} WHERE EXISTS (SELECT 1 FROM links WHERE id = ${linkId})
  `;
}

/**
 * Deletes the runs no decision at `now` reads: those over an hour old, except each link's latest
 * run, which may block it, and its latest landed ones, which a stall counts. A run of failures an
 * hour long already holds the longest retry wait, so dropping its oldest changes nothing.
 */
export async function pruneWakes(transaction: Bun.SQL, now: number): Promise<void> {
  await transaction`
    DELETE FROM wakes WHERE at <= ${now - HOUR}
      AND id NOT IN (SELECT MAX(id) FROM wakes GROUP BY link_id)
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY link_id ORDER BY id DESC) AS latest
          FROM wakes WHERE outcome = 'ran'
        ) WHERE latest <= ${STALL_AFTER}
      )
  `;
}

function ofLink<Row extends { linkId: string }>(rows: readonly Row[], id: string) {
  return rows.flatMap(({ linkId, ...row }) => (linkId === id ? [row] : []));
}

// What the bridge keeps of each linked channel's stream.
//
// A stream's row holds the revision a reconnect resumes after and what the frames up to it said.
// The client is its only writer, so it keeps a copy in memory and writes only when a frame changes
// it.

import {
  observedRoutine,
  observeSeriesRoutine,
  UNREAD_TOYBOX_STREAM,
  type ChannelObservation,
  type SeriesRoutine,
  type ToyBoxStream,
} from "@toybox/model/stream";
import { REQUESTS_COMMAND, routineState, type RoutineState } from "@toybox/model";

/** A link whose Toy Box channel the client follows. */
export type FollowedLink = { id: string; channelId: string };

type StreamRow = {
  revision: number | null;
  owner_spoke_at: number | null;
  provider: string | null;
  lead_state: "working" | "waiting" | "idle" | null;
  waiting_for: string | null;
  waiting_wake_at: number | null;
  restore_for: string | null;
  restore_wake_at: number | null;
};

/** Every link, whatever its status, so status can report its channel. */
export function readFollowedLinks(sql: Bun.SQL): Promise<FollowedLink[]> {
  return sql<FollowedLink[]>`SELECT id, toybox_channel_id AS channelId FROM links ORDER BY id`;
}

/** The stream as stored, or an unread one the next connection fills from a snapshot. */
export async function readToyBoxStream(sql: Bun.SQL, channelId: string): Promise<ToyBoxStream> {
  const [row] = await sql<StreamRow[]>`
    SELECT revision, owner_spoke_at, provider, lead_state, waiting_for, waiting_wake_at,
      restore_for, restore_wake_at
    FROM toybox_streams WHERE toybox_channel_id = ${channelId}
  `;
  return row ? streamFromRow(row) : UNREAD_TOYBOX_STREAM;
}

export async function writeToyBoxStream(
  transaction: Bun.SQL,
  channelId: string,
  stream: ToyBoxStream,
): Promise<void> {
  const row = { toybox_channel_id: channelId, ...streamColumns(stream) };
  await transaction`
    INSERT INTO toybox_streams ${transaction(row)}
    ON CONFLICT(toybox_channel_id) DO UPDATE SET
      revision = excluded.revision,
      owner_spoke_at = excluded.owner_spoke_at,
      provider = excluded.provider,
      lead_state = excluded.lead_state,
      waiting_for = excluded.waiting_for,
      waiting_wake_at = excluded.waiting_wake_at,
      restore_for = excluded.restore_for,
      restore_wake_at = excluded.restore_wake_at
  `;
}

/**
 * Records what `observation` shows of the link's requests routine and its publication series'
 * routines. Returns whether any of their states changed.
 */
export async function recordLinkRoutines(
  transaction: Bun.SQL,
  linkId: string,
  observation: ChannelObservation,
  now: number,
): Promise<boolean> {
  const [link] = await transaction<{ routineId: string; state: RoutineState }[]>`
    SELECT requests_routine_id AS routineId, routine_state AS state FROM links WHERE id = ${linkId}
  `;
  if (!link) return false;
  let changed = false;
  const routine = observedRoutine(observation, link.routineId);
  const state = routine === undefined ? link.state : routineState(routine, REQUESTS_COMMAND);
  if (state !== link.state) {
    await transaction`
      UPDATE links SET routine_state = ${state}, updated_at = ${now} WHERE id = ${linkId}
    `;
    changed = true;
  }
  const series = await transaction<(SeriesRoutine & { routineId: string })[]>`
    SELECT series, routine_id AS routineId, routine_state AS state, schedule,
      registered_at AS registeredAt
    FROM link_routines WHERE link_id = ${linkId}
  `;
  for (const { routineId, ...current } of series) {
    const routine = observedRoutine(observation, routineId);
    if (routine === undefined) continue;
    const next = observeSeriesRoutine(current, routine, now);
    if (Bun.deepEquals(next, current)) continue;
    await transaction`
      UPDATE link_routines
      SET routine_state = ${next.state}, schedule = ${next.schedule},
        registered_at = ${next.registeredAt}
      WHERE link_id = ${linkId} AND series = ${next.series}
    `;
    changed = true;
  }
  return changed;
}

function streamFromRow(row: StreamRow): ToyBoxStream {
  return {
    revision: row.revision,
    ownerSpokeAt: row.owner_spoke_at,
    provider: row.provider,
    lead: leadFromRow(row),
  };
}

function leadFromRow(row: StreamRow): ToyBoxStream["lead"] {
  switch (row.lead_state) {
    case null:
      return null;
    case "idle":
      return { state: "idle" };
    case "waiting":
      return { state: "waiting", waiting: { text: row.waiting_for!, wakeAt: row.waiting_wake_at } };
    case "working":
      return {
        state: "working",
        restore:
          row.restore_for === null ? null : { text: row.restore_for, wakeAt: row.restore_wake_at },
      };
  }
}

function streamColumns({ revision, ownerSpokeAt, provider, lead }: ToyBoxStream) {
  return {
    revision,
    owner_spoke_at: ownerSpokeAt,
    provider,
    lead_state: lead?.state ?? null,
    waiting_for: lead?.state === "waiting" ? lead.waiting.text : null,
    waiting_wake_at: lead?.state === "waiting" ? lead.waiting.wakeAt : null,
    restore_for: lead?.state === "working" ? (lead.restore?.text ?? null) : null,
    restore_wake_at: lead?.state === "working" ? (lead.restore?.wakeAt ?? null) : null,
  };
}

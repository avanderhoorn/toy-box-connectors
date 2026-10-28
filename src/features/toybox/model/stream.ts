// What a channel's stream tells the bridge.
//
// Each frame of a linked channel's stream reads into an observation, and observations fold in
// order into the stream the bridge keeps and the routines its link registered. A frame the bridge
// doesn't act on still moves the revision a reconnect resumes after. Setup reads a channel, linked
// or not, from the snapshot a stream read from scratch starts with.

import {
  agentPresenceSchema,
  channelFrameSchema,
  memberChangeSchema,
  publishCommand,
  routineChangeSchema,
  routineState,
  type AgentPresence,
  type ChannelFrame,
  type RoutineChange,
  type RoutineState,
  type ToyBoxMessage,
  type ToyBoxRoutine,
} from ".";
import { observeLeadPresence, type LeadPresence } from "./presence";

/**
 * What one frame says. Live presence came from an event rather than from a snapshot after a gap.
 * `members` says the channel's members may have changed, which a snapshot can't rule out.
 */
export type ChannelObservation = {
  revision?: number;
  provider?: string;
  lead?: { presence: AgentPresence; live: boolean };
  ownerSpokeAt?: number;
  routines?: { all: readonly ToyBoxRoutine[] } | RoutineChange;
  members?: true;
  deleted?: true;
};

/** A linked channel's stream as the bridge keeps it. */
export type ToyBoxStream = {
  revision: number | null;
  ownerSpokeAt: number | null;
  provider: string | null;
  lead: LeadPresence | null;
};

/** A stream the bridge has never read, which its first connection fills from a snapshot. */
export const UNREAD_TOYBOX_STREAM: ToyBoxStream = {
  revision: null,
  ownerSpokeAt: null,
  provider: null,
  lead: null,
};

/** A publication series' routine as its link registered it. */
export type SeriesRoutine = {
  series: string;
  state: RoutineState;
  schedule: string;
  registeredAt: number;
};

/** A channel as the snapshot its stream starts with shows it. */
export type ToyBoxChannelView = {
  provider: string;
  /** When the owner last posted among the snapshot's latest messages, or null. */
  ownerSpokeAt: number | null;
  routines: readonly ToyBoxRoutine[];
};

/** One frame of a channel's stream, or undefined for data the bridge can't read as one. */
export function parseChannelFrame(data: string): ChannelFrame | undefined {
  try {
    const frame = channelFrameSchema.safeParse(JSON.parse(data));
    return frame.success ? frame.data : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one frame of a channel's stream. `leadId` is the channel's ID, which its lead shares. */
export function observeChannelFrame(frame: ChannelFrame, leadId: string): ChannelObservation {
  switch (frame.type) {
    case "snapshot": {
      const { state } = frame;
      return {
        revision: state.revision,
        provider: state.channel.model.provider,
        lead: leadPresence(state.presence, leadId, false),
        ownerSpokeAt: latestOwnerMessage(state.messages),
        routines: { all: state.routines },
        members: true,
      };
    }
    case "resumed":
      return { lead: leadPresence(frame.presence, leadId, false) };
    case "presence":
      return { lead: leadPresence(frame.presence, leadId, true) };
    case "message":
      return { revision: frame.revision, ...observeMessage(frame.message) };
    case "model":
      return { revision: frame.revision, provider: frame.model.provider };
    case "deleted":
      return { members: true, deleted: true };
    default:
      return { revision: frame.revision };
  }
}

/**
 * What the first frame of a stream read from scratch shows of its channel: a snapshot's view, or
 * null when Toy Box deleted the channel. Any other frame can't start such a read, so it shows
 * nothing and is undefined.
 */
export function viewChannel(frame: ChannelFrame): ToyBoxChannelView | null | undefined {
  if (frame.type === "deleted") return null;
  if (frame.type !== "snapshot") return undefined;
  const { state } = frame;
  return {
    provider: state.channel.model.provider,
    ownerSpokeAt: latestOwnerMessage(state.messages) ?? null,
    routines: state.routines,
  };
}

/** The stream once `observation` applies. When the owner last spoke only moves forward. */
export function reduceToyBoxStream(
  stream: ToyBoxStream,
  observation: ChannelObservation,
): ToyBoxStream {
  const { revision, provider, lead, ownerSpokeAt } = observation;
  return {
    revision: revision ?? stream.revision,
    provider: provider ?? stream.provider,
    lead: lead ? observeLeadPresence(stream.lead, lead.presence, lead.live) : stream.lead,
    ownerSpokeAt:
      ownerSpokeAt === undefined || (stream.ownerSpokeAt ?? -Infinity) >= ownerSpokeAt
        ? stream.ownerSpokeAt
        : ownerSpokeAt,
  };
}

/**
 * What `observation` shows of a routine: the routine, null when a snapshot lacks it or Toy Box
 * deleted it, or undefined when the observation doesn't say.
 */
export function observedRoutine(
  observation: ChannelObservation,
  routineId: string,
): ToyBoxRoutine | null | undefined {
  const { routines } = observation;
  if (!routines) return undefined;
  if ("all" in routines) return routines.all.find(({ id }) => id === routineId) ?? null;
  if (routines.routine.id !== routineId) return undefined;
  return routines.type === "routine_deleted" ? null : routines.routine;
}

/**
 * The series' routine once Toy Box shows it as `routine`. A new schedule registers the series
 * again, so no run the old schedule missed is owed a catch-up.
 */
export function observeSeriesRoutine(
  series: SeriesRoutine,
  routine: ToyBoxRoutine | null,
  now: number,
): SeriesRoutine {
  const state = routineState(routine, publishCommand(series.series));
  if (!routine || routine.schedule === series.schedule) return { ...series, state };
  return { ...series, state, schedule: routine.schedule, registeredAt: now };
}

function leadPresence(
  presence: Record<string, unknown>,
  leadId: string,
  live: boolean,
): ChannelObservation["lead"] {
  const parsed = agentPresenceSchema.safeParse(presence[leadId]);
  return parsed.success ? { presence: parsed.data, live } : undefined;
}

// Toy Box has one user, the channel's owner. Agents never move the owner's clock.
function observeMessage(message: ToyBoxMessage): ChannelObservation {
  if (message.sender.type === "user") return { ownerSpokeAt: parseInstant(message.timestamp) };
  if (message.sender.type !== "system") return {};
  const change = routineChangeSchema.safeParse(message.content);
  if (change.success) return { routines: change.data };
  return memberChangeSchema.safeParse(message.content).success ? { members: true } : {};
}

function latestOwnerMessage(messages: readonly ToyBoxMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    const at = message.sender.type === "user" ? parseInstant(message.timestamp) : undefined;
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

function parseInstant(value: string): number | undefined {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

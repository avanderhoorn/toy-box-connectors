// The lead's presence.
//
// Every routine run clears the lead's waiting status, including runs Toy Box's own schedule starts.
// When the bridge sees presence move from waiting to working, it keeps what the lead was waiting for,
// and the lead's banner hands that back until presence leaves working.

import type { AgentPresence } from ".";

/** What a lead's waiting status said it was waiting for, and when Toy Box would wake it. */
export type WaitingStatus = { text: string; wakeAt: number | null };

/** The lead's presence as the bridge last saw it. `restore` is what it waited for before this turn. */
export type LeadPresence =
  | { state: "working"; restore: WaitingStatus | null }
  | { state: "waiting"; waiting: WaitingStatus }
  | { state: "idle" };

/**
 * The lead's presence once Toy Box reports `next`. Only a live move from waiting to working keeps
 * what the lead was waiting for. A move inside a gap may span turns the bridge never saw.
 */
export function observeLeadPresence(
  previous: LeadPresence | null,
  next: AgentPresence,
  live: boolean,
): LeadPresence {
  switch (next.state) {
    case "waiting":
      return { state: "waiting", waiting: { text: next.text, wakeAt: parseInstant(next.wakeAt) } };
    case "idle":
      return { state: "idle" };
    case "working":
      if (previous?.state === "working") return previous;
      if (live && previous?.state === "waiting") {
        return { state: "working", restore: previous.waiting };
      }
      return { state: "working", restore: null };
  }
}

/** The finish_agent_turn arguments that would restore a waiting status. */
export type RestoreArguments = { waitingFor: string; wakeAfterMinutes: number | null };

/**
 * What a working lead passes finish_agent_turn to wait again for what it waited for before this
 * turn. The wake is the time left until the old one, rounded up and kept within what
 * finish_agent_turn accepts, and there's none when the lead had none.
 */
export function restoreArguments(restore: WaitingStatus, now: number): RestoreArguments {
  return {
    waitingFor: restore.text,
    wakeAfterMinutes: restore.wakeAt === null ? null : wakeAfterMinutes(restore.wakeAt, now),
  };
}

function wakeAfterMinutes(wakeAt: number, now: number): number {
  return Math.min(Math.max(Math.ceil((wakeAt - now) / 60_000), 5), 120);
}

function parseInstant(value: string | undefined): number | null {
  const instant = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

// Planning a pass over every wake the bridge owes.
//
// A pass decides each link's wake, then the catch-ups a link without one owes, then the setup
// wakes for proposals that never became a link. A Toy Box channel runs at most one routine per
// pass, and none while a run is in flight or just landed, because the turn a run starts shows in
// presence only after Toy Box answers the run.

import type { RoutineState } from "@toybox/model";
import { wakeBudget, type RanWake } from "./budget";
import {
  decideCatchUp,
  decideProposalWake,
  decideWake,
  defaultWakeTimings,
  dueReminders,
  type LinkWakeState,
  type ToyBoxView,
  type WakeDecision,
  type WakeKind,
} from ".";

/** A publication period that nothing has published, skipped or caught up yet. */
export type OwedCatchUp = {
  series: string;
  routineId: string;
  routineState: RoutineState;
  scheduledAt: number;
  key: string;
};

/** A link as a pass reads it. */
export type ScheduledLink = LinkWakeState & {
  channelId: string;
  routineId: string;
  catchUps: readonly OwedCatchUp[];
};

/** A decided proposal for a channel without a link, whose lead hasn't heard the outcome. */
export type ProposalDebt = {
  approvalId: string;
  channelId: string;
  routineId: string;
  failures: { count: number; lastAt: number | null };
};

/** What a pass decides from. `proposals` is oldest first. */
export type WakePass = {
  links: readonly ScheduledLink[];
  proposals: readonly ProposalDebt[];
  /** The runs that landed within the budget's window. */
  ran: readonly RanWake[];
};

/** A routine to run now, and what its run is for. */
export type Wake = {
  kind: WakeKind;
  channelId: string;
  routineId: string;
  linkId: string | null;
  approvalId: string | null;
  catchUp: { series: string; key: string } | null;
  /** The requests whose reminder this run delivers. */
  reminded: readonly number[];
};

/** The routines to run now, and when to decide again. Null waits for something to change. */
export type WakePlan = { wakes: Wake[]; decideAt: number | null };

/**
 * Plans one pass. `busyUntil` holds each channel whose run is in flight, as Infinity, or landed
 * recently, as the time its turn should show in presence.
 */
export function planWakes(
  now: number,
  pass: WakePass,
  toyBox: (channelId: string) => ToyBoxView,
  busyUntil: ReadonlyMap<string, number>,
  timings = defaultWakeTimings,
): WakePlan {
  const ran = [...pass.ran];
  const wakes: Wake[] = [];
  let decideAt: number | null = null;
  const decideBy = (at: number) => {
    decideAt = Math.min(decideAt ?? at, at);
  };
  const free = (channelId: string) => {
    const until = busyUntil.get(channelId) ?? -Infinity;
    if (until <= now) return true;
    // A run in flight decides again when it lands.
    if (until !== Infinity) decideBy(until);
    return false;
  };
  const wakeNow = (decision: WakeDecision) => {
    if (decision.kind === "wait" && typeof decision.until === "number") decideBy(decision.until);
    return decision.kind === "wake" ? decision.reason : null;
  };
  const start = (wake: Wake) => {
    wakes.push(wake);
    ran.push({ linkId: wake.linkId, at: now });
  };

  for (const link of pass.links) {
    if (!free(link.channelId)) continue;
    const view = toyBox(link.channelId);
    const reason = wakeNow(decideWake(now, link, view, wakeBudget(ran), timings));
    if (reason) {
      start({
        kind: reason,
        channelId: link.channelId,
        routineId: link.routineId,
        linkId: link.id,
        approvalId: reason === "setup" ? link.setup[0]!.approvalId : null,
        catchUp: null,
        reminded: view.leadWorking ? [] : dueReminders(now, link.requests, timings).map(byId),
      });
      continue;
    }
    for (const owed of link.catchUps) {
      if (!wakeNow(decideCatchUp(now, owed, link, view, wakeBudget(ran), timings))) continue;
      start({
        kind: "catch_up",
        channelId: link.channelId,
        routineId: owed.routineId,
        linkId: link.id,
        approvalId: null,
        catchUp: { series: owed.series, key: owed.key },
        reminded: [],
      });
      break;
    }
  }

  // A channel's proposals run oldest first, one at a time.
  const oldest = new Map<string, ProposalDebt>();
  for (const proposal of pass.proposals) {
    if (!oldest.has(proposal.channelId)) oldest.set(proposal.channelId, proposal);
  }
  for (const proposal of oldest.values()) {
    if (!free(proposal.channelId)) continue;
    if (!wakeNow(decideProposalWake(now, proposal.failures, wakeBudget(ran), timings))) continue;
    start({
      kind: "setup",
      channelId: proposal.channelId,
      routineId: proposal.routineId,
      linkId: null,
      approvalId: proposal.approvalId,
      catchUp: null,
      reminded: [],
    });
  }

  return { wakes, decideAt };
}

function byId({ id }: { id: number }): number {
  return id;
}

// Planning a pass over every wake the bridge owes.
//
// A pass decides each link's wake, then the catch-ups a link without one owes. A Toy Box channel
// runs at most one routine per pass, and none while a run is in flight or just landed, because the
// turn a run starts shows in presence only after Toy Box answers the run. While the bridge can't
// use Slack, every wake waits for it instead, because a lead woken then couldn't act.

import type { RoutineState } from "@toybox/model";
import { wakeBudget, type RanWake } from "./budget";
import {
  decideCatchUp,
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

/** What a pass decides from. */
export type WakePass = {
  links: readonly ScheduledLink[];
  /** The runs that landed within the budget's window. */
  ran: readonly RanWake[];
};

/** A routine to run now, and what its run is for. */
export type Wake = {
  kind: WakeKind;
  channelId: string;
  routineId: string;
  linkId: string;
  catchUp: { series: string; key: string } | null;
  /** The requests whose reminder this run delivers. */
  reminded: readonly number[];
};

/**
 * The routines to run now, what the pass decided for each link whose channel wasn't busy, and when
 * to decide again. Null waits for something to change.
 */
export type WakePlan = {
  wakes: Wake[];
  decisions: Map<string, WakeDecision>;
  decideAt: number | null;
};

/**
 * Plans one pass. `busyUntil` holds each channel whose run is in flight, as Infinity, or landed
 * recently, as the time its turn should show in presence.
 */
export function planWakes(
  now: number,
  pass: WakePass,
  slackUsable: boolean,
  toyBox: (channelId: string) => ToyBoxView,
  busyUntil: ReadonlyMap<string, number>,
  timings = defaultWakeTimings,
): WakePlan {
  const ran = [...pass.ran];
  const wakes: Wake[] = [];
  const decisions = new Map<string, WakeDecision>();
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
  const settle = (decision: WakeDecision): WakeDecision => {
    if (decision.kind === "wake" && !slackUsable) return { kind: "wait", until: "slack" };
    if (decision.kind === "wait" && typeof decision.until === "number") decideBy(decision.until);
    return decision;
  };
  const wakeNow = (decision: WakeDecision) => settle(decision).kind === "wake";
  const start = (wake: Wake) => {
    wakes.push(wake);
    ran.push({ linkId: wake.linkId, at: now });
  };

  for (const link of pass.links) {
    if (!free(link.channelId)) continue;
    const view = toyBox(link.channelId);
    const decision = settle(decideWake(now, link, view, wakeBudget(ran), timings));
    decisions.set(link.id, decision);
    if (decision.kind === "wake") {
      start({
        kind: decision.reason,
        channelId: link.channelId,
        routineId: link.routineId,
        linkId: link.id,
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
        catchUp: { series: owed.series, key: owed.key },
        reminded: [],
      });
      break;
    }
  }

  return { wakes, decisions, decideAt };
}

function byId({ id }: { id: number }): number {
  return id;
}

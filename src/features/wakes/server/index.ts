// The wake scheduler.
//
// A pass expires the requests that waited their lifetime, so nobody is reminded of them, then reads
// everything wake decisions need, plans, starts each run the plan names, and records each run's
// outcome with what it changes. A pass follows any change to what a decision reads, the end of the
// earliest wait, and at least every minute, so a new publication period or a Mac that slept is
// noticed. Passes run one at a time, and a channel whose run is in flight or just landed isn't
// woken again until its turn can show in presence.

import type { BridgeDatabase } from "@bridge/server/database";
import { expireRequests } from "@requests/server/lifecycle";
import type { RoutineRunOutcome } from "@toybox/model";
import type { ToyBoxClient } from "@toybox/server";
import { defaultWakeTimings, type WakeDecision, type WakeTimings } from "@wakes/model";
import { planWakes, type Wake } from "@wakes/model/plan";
import { readWakePass, recordWake } from "./database";

export interface WakeScheduler {
  /** Decides again, because something a wake decision reads changed. */
  reconsider(): void;
  /** What the latest pass decided about waking a link's lead, or null before one has. */
  decision(linkId: string): WakeDecision | null;
  /** Stops once the pass and the runs in flight have recorded what they did. */
  stop(): Promise<void>;
}

export type WakeSchedulerOptions = {
  /** Called when the scheduler stops on an error that deciding again can't fix. */
  onError?: (error: unknown) => void;
  now?: () => number;
  timings?: WakeTimings;
};

/** The longest the scheduler goes without a pass. */
const MAX_WAIT = 60_000;

const unwoken: Record<Exclude<RoutineRunOutcome, "ran">, string> = {
  missing: "Toy Box has no such routine",
  refused: "Toy Box refused to run it",
  failed: "Toy Box didn't answer, so the wake will retry",
};

/** Starts deciding at once, and again whenever `reconsider` is called. */
export function startWakeScheduler(
  database: BridgeDatabase,
  toyBox: Pick<ToyBoxClient, "view" | "runRoutine">,
  { onError = () => {}, now = Date.now, timings = defaultWakeTimings }: WakeSchedulerOptions = {},
): WakeScheduler {
  // Infinity while a channel's run is in flight, then when its turn should show in presence.
  const busyUntil = new Map<string, number>();
  let decisions = new Map<string, WakeDecision>();
  const runs = new Set<Promise<void>>();
  let timer: Timer | undefined;
  let deciding: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  function reconsider() {
    if (stopped) return;
    again = true;
    deciding ??= decideWhileChanged();
  }

  // A change during a pass earns one more pass, however many changes there were.
  async function decideWhileChanged() {
    try {
      while (again && !stopped) {
        again = false;
        await decide();
      }
    } catch (error) {
      fail(error);
    } finally {
      deciding = undefined;
    }
  }

  async function decide() {
    clearTimeout(timer);
    const at = now();
    await database.write((transaction) => expireRequests(transaction, at));
    const pass = await database.read((sql) => readWakePass(sql, at));
    if (stopped) return;
    for (const [channelId, until] of busyUntil) if (until <= at) busyUntil.delete(channelId);
    const plan = planWakes(at, pass, toyBox.view, busyUntil, timings);
    // A link whose channel is busy keeps the decision that started the run.
    const previous = decisions;
    decisions = new Map();
    for (const { id } of pass.links) {
      const decision = plan.decisions.get(id) ?? previous.get(id);
      if (decision) decisions.set(id, decision);
    }
    for (const wake of plan.wakes) start(wake);
    const wait = Math.min((plan.decideAt ?? Infinity) - now(), MAX_WAIT);
    timer = setTimeout(reconsider, Math.max(wait, 0));
  }

  function start(wake: Wake) {
    busyUntil.set(wake.channelId, Infinity);
    const run = runWake(wake)
      .catch(fail)
      .finally(() => {
        runs.delete(run);
        reconsider();
      });
    runs.add(run);
  }

  async function runWake(wake: Wake) {
    const outcome = await toyBox.runRoutine(wake.channelId, wake.routineId);
    const at = now();
    await database.write((transaction) => recordWake(transaction, wake, outcome, at, timings));
    if (outcome === "ran") {
      busyUntil.set(wake.channelId, at + timings.settle);
      return;
    }
    busyUntil.delete(wake.channelId);
    console.error(
      `Couldn't wake the lead of Toy Box channel ${wake.channelId} with routine ${wake.routineId}: ${unwoken[outcome]}.`,
    );
  }

  function fail(error: unknown) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    console.error("Stopped waking leads:", error);
    onError(error);
  }

  reconsider();
  return {
    reconsider,
    decision(linkId) {
      return decisions.get(linkId) ?? null;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await deciding;
      await Promise.all(runs);
    },
  };
}

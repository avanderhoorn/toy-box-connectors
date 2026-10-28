// The wake scheduler.
//
// A pass expires the requests that waited their lifetime, so nobody is reminded of them, prunes the
// run log, then reads every link and wakes each lead its decision says to, one at a time,
// recording each run's outcome. A pass follows any change to what a decision reads, every run,
// the end of the earliest wait, and at least every minute, so a Mac that slept is noticed.

import type { BridgeDatabase } from "@bridge/server/database";
import { expireRequests } from "@requests/server/lifecycle";
import { REQUESTS_COMMAND, type RoutineRunOutcome } from "@toybox/model";
import { decideWake, defaultWakeTimings, type WakeTimings } from "@wakes/model";
import { pruneWakes, readLinkWakes, recordWake } from "./database";

export interface WakeScheduler {
  /** Decides again, because something a wake decision reads changed. */
  reconsider(): void;
  /** Stops once the pass in progress has recorded what it did. */
  stop(): Promise<void>;
}

export type WakeSchedulerOptions = {
  /** Called when the scheduler stops on an error that deciding again can't fix. */
  onError?: (error: unknown) => void;
  now?: () => number;
  timings?: WakeTimings;
};

/** Runs the routine that wakes the lead of a Toy Box channel. */
export type WakeLead = (channelId: string) => Promise<RoutineRunOutcome>;

/** The longest the scheduler goes without a pass. */
const MAX_WAIT = 60_000;

const unwoken: Record<Exclude<RoutineRunOutcome, "ran">, string> = {
  missing: `no routine in the channel runs \`${REQUESTS_COMMAND}\``,
  failed: "Toy Box didn't run the routine, so the wake will retry",
  refused: "Toy Box refused to run the routine, so wakes wait for a new request",
};

/** Starts deciding at once, and again whenever `reconsider` is called. */
export function startWakeScheduler(
  database: BridgeDatabase,
  wakeLead: WakeLead,
  { onError = () => {}, now = Date.now, timings = defaultWakeTimings }: WakeSchedulerOptions = {},
): WakeScheduler {
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
    await database.write(async (transaction) => {
      await expireRequests(transaction, at);
      await pruneWakes(transaction, at);
    });
    let next = at + MAX_WAIT;
    for (const link of await database.read(readLinkWakes)) {
      if (stopped) return;
      const decision = decideWake(at, link, timings);
      if (decision.kind === "wait") next = Math.min(next, decision.until);
      if (decision.kind !== "wake") continue;
      // A run covers what changed before it started, so it's logged at its start.
      const startedAt = now();
      const outcome = await wakeLead(link.channelId);
      await database.write((transaction) => recordWake(transaction, link.id, startedAt, outcome));
      if (outcome !== "ran") {
        console.error(
          `Couldn't wake the lead of Toy Box channel ${link.channelId}: ${unwoken[outcome]}.`,
        );
      }
      again = true;
    }
    timer = setTimeout(reconsider, Math.max(next - now(), 0));
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
    async stop() {
      stopped = true;
      // A pass in progress arms the next one as it ends, so its timer is cleared once it's done.
      await deciding;
      clearTimeout(timer);
    },
  };
}

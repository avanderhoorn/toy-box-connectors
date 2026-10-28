// When the bridge wakes a link's lead.
//
// Toy Box's own wakes live in memory and fire at most once, so the bridge decides from what it
// stored: the link's open and seen requests and the log of routine runs it attempted. A burst of
// new requests earns one wake once it settles. A lead that leaves them unread is woken again after
// longer and longer waits, then left alone until something new arrives. A request the lead read
// and left gets one reminder unless the lead is woken first. A run Toy Box couldn't take retries
// with backoff, one it refused waits for something new, and no lead is woken more than 12 times an
// hour.

import { z } from "zod";
import type { Request, RequestAttention } from "@requests/model/lifecycle";
import type { RoutineRunOutcome } from "@toybox/model";

/** A request that may still need the lead. Answering and finished requests never do. */
export type WakeRequest = {
  state: "open" | "seen";
  attention: RequestAttention | null;
  /** When it last needed reading: it arrived, changed, or its reply failed. */
  changedAt: number;
  /** When the lead last read or answered it. */
  touchedAt: number | null;
};

/** A routine run the bridge attempted, and what Toy Box did with it. */
export type WakeRun = { at: number; outcome: RoutineRunOutcome };

/** What the wake policy reads of a link. `runs` is newest first. */
export type LinkWakeState = {
  active: boolean;
  requests: readonly WakeRequest[];
  runs: readonly WakeRun[];
};

/** What to do about a link's lead now. Stalled and blocked links stay so until something new arrives. */
export type WakeDecision =
  | { kind: "wake" }
  | { kind: "wait"; until: number }
  | { kind: "idle" }
  | { kind: "stalled" }
  | { kind: "blocked" };

const duration = z.number().int().nonnegative();

/** How long the wake policy waits, in milliseconds. */
export const wakeTimingsSchema = z
  .object({
    debounce: duration.describe("How long a burst settles after its latest change."),
    debounceLimit: duration.describe("The longest a burst's oldest change waits for its wake."),
    backoff: z
      .tuple([duration, duration, duration])
      .readonly()
      .describe("The waits after the first, second and third wakes that left requests unread."),
    remind: duration.describe("How long a request the lead read waits before its one reminder."),
    retry: duration.describe("The wait after a failed run, doubling with each failure in a row."),
    retryLimit: duration.describe("The longest wait after a failed run."),
  })
  .strict();
export type WakeTimings = z.output<typeof wakeTimingsSchema>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const defaultWakeTimings: WakeTimings = {
  debounce: 10_000,
  debounceLimit: 30_000,
  backoff: [3 * MINUTE, 6 * MINUTE, 12 * MINUTE],
  remind: 30 * MINUTE,
  retry: 15_000,
  retryLimit: 5 * MINUTE,
};

/** After this many wakes leave the same requests unread, a link stalls. */
export const STALL_AFTER = 4;

/** The most wakes one link's lead gets in any hour. */
export const WAKES_PER_HOUR = 12;

/** Whether to wake the link's lead at `now`, or until when to wait. */
export function decideWake(
  now: number,
  link: LinkWakeState,
  timings = defaultWakeTimings,
): WakeDecision {
  if (!link.active) return { kind: "idle" };
  const pending = link.requests.filter(isPending).map(({ changedAt }) => changedAt);
  const [latest] = link.runs;
  if (latest?.outcome === "refused" && !pending.some((changedAt) => changedAt > latest.at)) {
    return { kind: "blocked" };
  }
  const woken = link.runs.flatMap(({ at, outcome }) => (outcome === "ran" ? [at] : []));
  const lastWokenAt = woken[0] ?? -Infinity;
  const fresh = pending.filter((changedAt) => changedAt > lastWokenAt);

  let due: number;
  if (fresh.length) {
    // One wake covers a burst: 10 seconds after its latest change and at most 30 after its oldest.
    due = Math.min(
      Math.max(...fresh) + timings.debounce,
      Math.min(...fresh) + timings.debounceLimit,
    );
  } else if (pending.length) {
    const unread = woken.filter((at) => at >= Math.max(...pending)).length;
    if (unread >= STALL_AFTER) return { kind: "stalled" };
    due = lastWokenAt + timings.backoff[unread - 1]!;
  } else {
    const reminders = link.requests.flatMap(({ touchedAt }) =>
      touchedAt !== null && touchedAt > lastWokenAt ? [touchedAt + timings.remind] : [],
    );
    if (!reminders.length) return { kind: "idle" };
    due = Math.min(...reminders);
  }

  due = Math.max(due, retryAt(link.runs, timings), hourlySlot(woken, now));
  return due > now ? { kind: "wait", until: due } : { kind: "wake" };
}

/**
 * Whether a request waits for the lead to read it: it's new, or it changed or its reply failed
 * since the lead read it. Inbox shows the lead exactly these.
 */
export function isPending({ state, attention }: Pick<Request, "state" | "attention">): boolean {
  return state === "open" || (state === "seen" && attention !== null);
}

/** How long to wait after the `failures`-th failed run in a row. */
export function retryDelay(failures: number, timings = defaultWakeTimings): number {
  return Math.min(timings.retry * 2 ** Math.max(failures - 1, 0), timings.retryLimit);
}

// Runs Toy Box didn't take since the latest one it did push the next try back.
function retryAt(runs: readonly WakeRun[], timings: WakeTimings): number {
  const latestRan = runs.findIndex(({ outcome }) => outcome === "ran");
  const failures = latestRan === -1 ? runs.length : latestRan;
  return failures ? runs[0]!.at + retryDelay(failures, timings) : -Infinity;
}

// With 12 wakes in the past hour, the next waits until the oldest of them is an hour old.
function hourlySlot(woken: readonly number[], now: number): number {
  const oldest = woken[WAKES_PER_HOUR - 1];
  return oldest === undefined || oldest <= now - HOUR ? -Infinity : oldest + HOUR;
}

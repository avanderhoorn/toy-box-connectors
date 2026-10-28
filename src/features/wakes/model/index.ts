// When the bridge wakes a link's lead.
//
// Toy Box's own wakes are at most once and live in memory, so the bridge decides from stored state
// alone and decides again whenever requests, presence, the stream or the clock change. Waking means
// running a routine: the link's requests routine, or a publication series' routine to catch up a
// period the lead missed.

import { z } from "zod";
import {
  currentPeriod,
  type PublicationSeries,
  type SeriesPeriod,
} from "@outbox/model/publications";
import type { RequestAttention } from "@requests/model/lifecycle";
import type { RoutineRunOutcome, RoutineState } from "@toybox/model";
import type { WakeBudget } from "./budget";

/** Why the bridge ran a routine. */
export type WakeKind = "requests" | "reminder" | "setup" | "catch_up";

/** What Toy Box did with a wake. */
export type WakeOutcome = RoutineRunOutcome;

/** Why the bridge won't wake a link's lead until a person changes something. */
export type WakeBlock = "link_inactive" | "routine_missing" | "provider" | "refused";

/**
 * What to do about a link's lead now. A wait names when to decide again, or that the decision
 * waits for the lead to go idle, for the channel's stream to connect or for the bridge to be able
 * to use Slack. A stalled link stays so until something new arrives.
 */
export type WakeDecision =
  | { kind: "wake"; reason: WakeKind }
  | { kind: "wait"; until: number | "lead_idle" | "toy_box" | "slack" }
  | { kind: "idle" }
  | { kind: "blocked"; reason: WakeBlock }
  | { kind: "stalled" };

/** A request that may still need the lead. Answering and finished requests never do. */
export type WakeRequest = {
  id: number;
  state: "open" | "seen" | "in_progress";
  attention: RequestAttention | null;
  heldAt: number | null;
  changedAt: number;
  seenAt: number | null;
  touchedAt: number | null;
  remindedAt: number | null;
};

/** A proposal the owner decided whose outcome the lead hasn't heard. */
export type SetupDebt = { approvalId: string; decidedAt: number };

/** What the wake policy reads of a link. `setup` is oldest first. */
export type LinkWakeState = {
  id: string;
  status: "active" | "paused" | "suspended";
  routineState: RoutineState;
  blockedReason: "refused" | null;
  requests: readonly WakeRequest[];
  setup: readonly SetupDebt[];
  lastWakeAt: number | null;
  lastInboxAt: number | null;
  wakesSinceInbox: number;
  retryAt: number | null;
};

/** What the bridge knows of a link's Toy Box channel from its stream. */
export type ToyBoxView = { connected: boolean; provider: string | null; leadWorking: boolean };

const duration = z.number().int().nonnegative();

/** How long the wake policy waits, in milliseconds. */
export const wakeTimingsSchema = z
  .object({
    debounce: duration.describe("How long a burst settles after its latest change."),
    debounceLimit: duration.describe("The longest a burst's oldest change waits for its wake."),
    steerAfter: duration.describe("How long a working lead gets before a wake steers into it."),
    settle: duration.describe(
      "How long a run that landed holds its channel, so the turn it started can show as working.",
    ),
    backoff: z
      .tuple([duration, duration, duration])
      .readonly()
      .describe("The waits after the first, second and third wakes inbox didn't follow."),
    remindSeen: duration.describe("How long a seen request makes no progress before a reminder."),
    remindInProgress: duration.describe(
      "How long a request in progress stays quiet before a reminder.",
    ),
    retry: duration.describe("The wait after a failed run, doubling with each failure in a row."),
    retryLimit: duration.describe("The longest wait after a failed run."),
    catchUpAfter: duration.describe(
      "How long a publication may be missing after its scheduled run before it's caught up.",
    ),
  })
  .strict();
export type WakeTimings = z.output<typeof wakeTimingsSchema>;

const MINUTE = 60_000;

export const defaultWakeTimings: WakeTimings = {
  debounce: 10_000,
  debounceLimit: 30_000,
  steerAfter: 2 * MINUTE,
  settle: 10_000,
  backoff: [3 * MINUTE, 6 * MINUTE, 12 * MINUTE],
  remindSeen: 30 * MINUTE,
  remindInProgress: 120 * MINUTE,
  retry: 15_000,
  retryLimit: 5 * MINUTE,
  catchUpAfter: 120 * MINUTE,
};

/** After this many wakes without an inbox call, a link stalls until something new arrives. */
export const STALL_AFTER = 4;

/**
 * Whether to run a link's requests routine now. Setup debts skip the debounce, backoff and stall,
 * because the lead learns a decision's outcome only from inbox and one landed run settles them.
 */
export function decideWake(
  now: number,
  link: LinkWakeState,
  toyBox: ToyBoxView,
  budget: WakeBudget,
  timings = defaultWakeTimings,
): WakeDecision {
  const block = wakeBlock(link, link.routineState, toyBox.provider);
  if (block) return { kind: "blocked", reason: block };

  const pending = link.requests.filter(isPending);
  const reminderAt = toyBox.leadWorking ? null : nextReminderAt(link.requests, timings);
  if (!pending.length && reminderAt === null && !link.setup.length) return { kind: "idle" };
  if (!toyBox.connected || toyBox.provider === null) return { kind: "wait", until: "toy_box" };
  if (link.retryAt !== null && link.retryAt > now) return { kind: "wait", until: link.retryAt };

  const setup = setupDue(now, link, toyBox.leadWorking, timings);
  const requests = requestsDue(now, link, pending, reminderAt, toyBox.leadWorking, timings);
  const candidates = [setup, typeof requests === "number" ? requests : null].filter(
    (due) => due !== null,
  );
  if (!candidates.length) {
    return requests === "stalled" ? { kind: "stalled" } : { kind: "wait", until: "lead_idle" };
  }
  const due = Math.max(Math.min(...candidates), budget.nextSlot(link.id, now));
  if (due > now) return { kind: "wait", until: due };
  return {
    kind: "wake",
    reason: link.setup.length ? "setup" : pending.length ? "requests" : "reminder",
  };
}

/**
 * Whether to run a series' routine to catch up the period its latest scheduled run started. The
 * caller has checked the period is owed: the run came after the series was registered, and no
 * live or skipped item or earlier catch-up holds its key.
 */
export function decideCatchUp(
  now: number,
  catchUp: { scheduledAt: number; routineState: RoutineState },
  link: Pick<LinkWakeState, "id" | "status" | "blockedReason" | "retryAt">,
  toyBox: ToyBoxView,
  budget: WakeBudget,
  timings = defaultWakeTimings,
): WakeDecision {
  const block = wakeBlock(link, catchUp.routineState, toyBox.provider);
  if (block) return { kind: "blocked", reason: block };
  if (!toyBox.connected || toyBox.provider === null) return { kind: "wait", until: "toy_box" };
  if (link.retryAt !== null && link.retryAt > now) return { kind: "wait", until: link.retryAt };
  const due = catchUp.scheduledAt + timings.catchUpAfter;
  if (due > now) return { kind: "wait", until: due };
  // Toy Box also runs a routine it missed while asleep, so the two never stack.
  if (toyBox.leadWorking) return { kind: "wait", until: "lead_idle" };
  const slot = budget.nextSlot(link.id, now);
  return slot > now ? { kind: "wait", until: slot } : { kind: "wake", reason: "catch_up" };
}

/**
 * Whether to run the requests routine a proposal named, for a proposal that never became a link.
 * Only a failed run retries. A missing routine or a refusal ends the debt, because there's no link
 * to block and retrying can't help.
 */
export function decideProposalWake(
  now: number,
  failures: { count: number; lastAt: number | null },
  budget: WakeBudget,
  timings = defaultWakeTimings,
): WakeDecision {
  const retryAt =
    failures.lastAt === null ? now : failures.lastAt + retryDelay(failures.count, timings);
  const due = Math.max(now, retryAt, budget.nextSlot(null, now));
  return due > now ? { kind: "wait", until: due } : { kind: "wake", reason: "setup" };
}

/**
 * Why waking a link's lead would be wrong until a person acts, or null. A missing routine blocks
 * and a drifted one only warns. A lead's provider never changes, so a provider block is permanent.
 */
export function wakeBlock(
  link: Pick<LinkWakeState, "status" | "blockedReason">,
  routineState: RoutineState,
  provider: string | null,
): WakeBlock | null {
  if (link.status !== "active") return "link_inactive";
  if (routineState === "missing") return "routine_missing";
  if (provider !== null && provider !== "copilot") return "provider";
  return link.blockedReason;
}

/**
 * The requests owed a reminder at `now`: a seen request with no progress for 30 minutes, or one in
 * progress and quiet for 2 hours. Each lead touch earns one reminder, and a held request none.
 */
export function dueReminders<R extends WakeRequest>(
  now: number,
  requests: readonly R[],
  timings = defaultWakeTimings,
): R[] {
  return requests.filter((request) => (reminderAt(request, timings) ?? Infinity) <= now);
}

/** How long to wait after the `failures`-th failed run in a row. */
export function retryDelay(failures: number, timings = defaultWakeTimings): number {
  return Math.min(timings.retry * 2 ** Math.max(failures - 1, 0), timings.retryLimit);
}

/**
 * The period a series may owe a catch-up for at `now`: the one its latest scheduled run started,
 * unless that run came before the series was registered or its schedule last changed.
 */
export function catchUpPeriod(
  series: PublicationSeries & { registeredAt: number },
  now: number,
): SeriesPeriod | null {
  const period = currentPeriod(series, now);
  return period && period.scheduledAt >= series.registeredAt ? period : null;
}

/**
 * Whether a request waits for the lead to read it: it's new, or it changed or its reply failed
 * since the lead read it. Inbox shows the lead exactly these. Answering requests wait on the
 * outbox, not the lead, and are never read here.
 */
export function isPending({ state, attention }: Pick<WakeRequest, "state" | "attention">): boolean {
  return state === "open" || attention === "updated" || attention === "reply_failed";
}

function setupDue(
  now: number,
  link: LinkWakeState,
  leadWorking: boolean,
  timings: WakeTimings,
): number | null {
  const [oldest] = link.setup;
  if (!oldest) return null;
  if (!leadWorking) return now;
  // A turn the bridge just started reads inbox soon enough, so only steer into one that's older.
  return Math.max(oldest.decidedAt, link.lastWakeAt ?? -Infinity) + timings.steerAfter;
}

function requestsDue(
  now: number,
  link: LinkWakeState,
  pending: readonly WakeRequest[],
  reminderAt: number | null,
  leadWorking: boolean,
  timings: WakeTimings,
): number | "stalled" | "lead_idle" | null {
  if (!pending.length && reminderAt === null) return null;
  const fresh = pending.some(({ changedAt }) => changedAt > (link.lastWakeAt ?? -Infinity));
  if (link.wakesSinceInbox >= STALL_AFTER && !fresh) return "stalled";

  let due = pending.length ? debounced(pending, timings) : Math.max(reminderAt ?? now, now);
  if (!fresh && link.lastWakeAt !== null) {
    due = Math.max(due, link.lastWakeAt + wakeBackoff(link.wakesSinceInbox, timings));
  }
  // A working lead has no reminders, so it has pending requests here.
  if (!leadWorking) return due;
  const oldest = Math.min(...pending.map(({ changedAt }) => changedAt));
  // A running turn that read inbox after these changed already has them. Let it finish.
  if ((link.lastInboxAt ?? -Infinity) >= oldest) return "lead_idle";
  return Math.max(due, oldest + timings.steerAfter);
}

// One wake covers a burst: 10 seconds after its latest change and at most 30 after its oldest.
function debounced(pending: readonly WakeRequest[], timings: WakeTimings): number {
  const changes = pending.map(({ changedAt }) => changedAt);
  return Math.min(
    Math.max(...changes) + timings.debounce,
    Math.min(...changes) + timings.debounceLimit,
  );
}

function wakeBackoff(wakesSinceInbox: number, timings: WakeTimings): number {
  if (wakesSinceInbox === 0) return 0;
  return timings.backoff[Math.min(wakesSinceInbox, timings.backoff.length) - 1]!;
}

function nextReminderAt(requests: readonly WakeRequest[], timings: WakeTimings): number | null {
  const times = requests.flatMap((request) => reminderAt(request, timings) ?? []);
  return times.length ? Math.min(...times) : null;
}

function reminderAt(request: WakeRequest, timings: WakeTimings): number | null {
  if (request.state === "open" || request.heldAt !== null) return null;
  const since = Math.max(request.seenAt ?? -Infinity, request.touchedAt ?? -Infinity);
  if (since === -Infinity || (request.remindedAt ?? -Infinity) >= since) return null;
  return since + (request.state === "seen" ? timings.remindSeen : timings.remindInProgress);
}

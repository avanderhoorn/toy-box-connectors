// The wake budget.
//
// Runs that landed in the last hour decide how soon the next may start: 12 for one link and 30
// across all of them, counting setup runs for proposals that never became a link.

/** A routine run that landed. A run for a proposal that never became a link has no link. */
export type RanWake = { linkId: string | null; at: number };

/** When the budget next allows a run for a link, or for no link. */
export type WakeBudget = { nextSlot(linkId: string | null, now: number): number };

export const LINK_WAKES_PER_HOUR = 12;
export const WAKES_PER_HOUR = 30;
/** How far back the budget counts runs. */
export const WAKE_BUDGET_WINDOW = 60 * 60_000;

/** The budget that `ran`, every run that landed recently, leaves. */
export function wakeBudget(ran: readonly RanWake[]): WakeBudget {
  return {
    nextSlot(linkId, now) {
      const recent = ran.filter(({ at }) => at > now - WAKE_BUDGET_WINDOW);
      const own = recent.filter((wake) => linkId !== null && wake.linkId === linkId);
      return Math.max(
        now,
        slotAfter(recent, WAKES_PER_HOUR, now),
        slotAfter(own, LINK_WAKES_PER_HOUR, now),
      );
    },
  };
}

// A full window frees a slot an hour after the limit-th latest run, when that run leaves it.
function slotAfter(recent: readonly RanWake[], limit: number, now: number): number {
  if (recent.length < limit) return now;
  return (
    recent.map(({ at }) => at).toSorted((left, right) => right - left)[limit - 1]! +
    WAKE_BUDGET_WINDOW
  );
}

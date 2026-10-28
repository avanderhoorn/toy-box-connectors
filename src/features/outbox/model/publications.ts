// Publication periods.
//
// A publication's key names its series and the first local day of the period that the series'
// latest scheduled run falls in. A run that publishes after midnight still lands in its own period,
// and catch-up computes the same key. Toy Box reads routine schedules in local time, so the period
// does too.

import { CronExpressionParser } from "cron-parser";

/** A publication series as its link registered it. */
export type PublicationSeries = { series: string; period: "day" | "week"; schedule: string };

/** The latest time at or before `now` that `schedule` runs, or null for a schedule that can't. */
export function latestScheduledRun(schedule: string, now: number): number | null {
  try {
    // prev() looks strictly before its start, so starting just after now includes a run at now.
    return CronExpressionParser.parse(schedule, { currentDate: new Date(now + 1) })
      .prev()
      .getTime();
  } catch {
    return null;
  }
}

/** The key of the publication `series` owes for its period at `now`, or null if it has none. */
export function publicationKey(series: PublicationSeries, now: number): string | null {
  const run = latestScheduledRun(series.schedule, now);
  if (run === null) return null;
  const date = new Date(run);
  // Calendar arithmetic, so a week that changes clocks still starts on its Monday.
  const firstDay =
    series.period === "day" ? date.getDate() : date.getDate() - ((date.getDay() + 6) % 7);
  return `${series.series}/${localDay(new Date(date.getFullYear(), date.getMonth(), firstDay))}`;
}

/** The key of the one correction that may replace the publication keyed `key`. */
export function correctionKey(key: string): string {
  return `${key}/correction`;
}

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

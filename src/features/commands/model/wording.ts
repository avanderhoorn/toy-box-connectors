// How commands word counts and spans of time.
//
// Every command counts the same way and gives time to the minute, so a span reads alike wherever
// the lead meets it, whenever the CLI prints it.

/** "1 message" or "3 messages". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** How long ago something happened, to the minute. */
export function ago(milliseconds: number): string {
  return milliseconds < 60_000 ? "just now" : `${duration(milliseconds)} ago`;
}

/** A span in whole minutes, hours under two days, or days, rounding down. */
export function duration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(milliseconds, 0) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return count(hours, "hour");
  return count(Math.floor(hours / 24), "day");
}

// Every command gives time to the minute, so a span reads alike whenever the CLI prints it.

export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

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

/** A time by the bridge's clock, to the minute, such as Fri, Oct 30 at 16:00. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

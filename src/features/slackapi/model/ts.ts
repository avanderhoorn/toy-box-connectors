import { z } from "zod";

// A Slack ts is an exact decimal string that's unique within its channel. It's
// stored as Slack sent it and never parsed into a float, which would merge
// neighbors such as 1700000000.000100 and 1700000000.000101.

const tsPattern = /^\d+\.\d+$/;

export const slackTsSchema = z
  .string()
  .regex(tsPattern)
  .describe("A Slack message timestamp, such as 1700000000.000100, kept as Slack sent it");

export type SlackTs = z.output<typeof slackTsSchema>;

/** Orders two ts values by their decimal value: negative, zero or positive, like a sort comparator. */
export function compareTs(left: SlackTs, right: SlackTs): number {
  const [leftSeconds, leftFraction] = decimalParts(left);
  const [rightSeconds, rightFraction] = decimalParts(right);
  if (leftSeconds.length !== rightSeconds.length) {
    return leftSeconds.length < rightSeconds.length ? -1 : 1;
  }
  if (leftSeconds !== rightSeconds) return leftSeconds < rightSeconds ? -1 : 1;

  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftDigits = leftFraction.padEnd(width, "0");
  const rightDigits = rightFraction.padEnd(width, "0");
  if (leftDigits === rightDigits) return 0;
  return leftDigits < rightDigits ? -1 : 1;
}

/** The later of two ts values. */
export function laterTs(left: SlackTs, right: SlackTs): SlackTs {
  return compareTs(left, right) >= 0 ? left : right;
}

/** The ts Slack would give a message posted at `milliseconds` since the epoch. */
export function tsAt(milliseconds: number): SlackTs {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(`${milliseconds} isn't a time a Slack ts can name`);
  }
  const seconds = Math.floor(milliseconds / 1000);
  const fraction = String(milliseconds % 1000).padStart(3, "0");
  return `${seconds}.${fraction}000`;
}

/** Splits a ts into whole seconds without leading zeros and its fraction digits. */
function decimalParts(ts: SlackTs): [seconds: string, fraction: string] {
  if (!tsPattern.test(ts)) throw new TypeError(`${JSON.stringify(ts)} isn't a Slack ts`);
  const point = ts.indexOf(".");
  const seconds = ts.slice(0, point).replace(/^0+(?=\d)/, "");
  return [seconds, ts.slice(point + 1)];
}

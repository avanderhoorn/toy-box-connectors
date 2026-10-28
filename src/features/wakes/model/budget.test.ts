import { describe, expect, test } from "bun:test";
import { LINK_WAKES_PER_HOUR, WAKES_PER_HOUR, wakeBudget, type RanWake } from "./budget";

const now = Date.parse("2026-10-27T16:00:00.000Z");
const minutes = (count: number) => now + count * 60_000;

function runs(count: number, linkId: string, from: number): RanWake[] {
  return Array.from({ length: count }, (_, index) => ({ linkId, at: from + index * 60_000 }));
}

describe("the wake budget", () => {
  test("allows a run now while both limits have room", () => {
    const budget = wakeBudget(runs(LINK_WAKES_PER_HOUR - 1, "link-1", minutes(-30)));
    expect(budget.nextSlot("link-1", now)).toBe(now);
  });

  test("a link with 12 runs in the last hour waits until the oldest of them leaves it", () => {
    const budget = wakeBudget(runs(LINK_WAKES_PER_HOUR, "link-1", minutes(-50)));
    expect(budget.nextSlot("link-1", now)).toBe(minutes(10));
    expect(budget.nextSlot("link-2", now)).toBe(now);
    expect(budget.nextSlot("link-1", minutes(10))).toBe(minutes(10));
  });

  test("30 runs across links in the last hour make every link wait", () => {
    const budget = wakeBudget([
      ...runs(10, "link-1", minutes(-55)),
      ...runs(10, "link-2", minutes(-45)),
      ...runs(WAKES_PER_HOUR - 20, "link-4", minutes(-35)),
    ]);
    expect(budget.nextSlot("link-3", now)).toBe(minutes(5));
  });

  test("runs an hour old or older don't count", () => {
    const budget = wakeBudget(runs(WAKES_PER_HOUR, "link-1", minutes(-90)));
    expect(budget.nextSlot("link-1", now)).toBe(now);
  });
});

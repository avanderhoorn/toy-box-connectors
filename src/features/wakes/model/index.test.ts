import { describe, expect, test } from "bun:test";
import {
  decideWake,
  retryDelay,
  STALL_AFTER,
  WAKES_PER_HOUR,
  type LinkWakeState,
  type WakeRequest,
  type WakeRun,
} from ".";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const open = (changedAt: number): WakeRequest => ({
  state: "open",
  attention: null,
  changedAt,
  touchedAt: null,
});
const read = (touchedAt: number): WakeRequest => ({
  state: "seen",
  attention: null,
  changedAt: touchedAt,
  touchedAt,
});
const ran = (at: number): WakeRun => ({ at, outcome: "ran" });

function link(requests: WakeRequest[], runs: WakeRun[] = []): LinkWakeState {
  return { active: true, requests, runs };
}

describe("deciding whether to wake a link's lead", () => {
  test("waits for a burst to settle, at most 30 seconds after its first change", () => {
    expect(decideWake(NOW, link([open(NOW - 4 * SECOND)]))).toEqual({
      kind: "wait",
      until: NOW + 6 * SECOND,
    });
    expect(decideWake(NOW, link([open(NOW - 10 * SECOND)]))).toEqual({ kind: "wake" });

    const burst = [0, 8, 16, 24].map((seconds) => open(NOW - 30 * SECOND + seconds * SECOND));
    expect(decideWake(NOW, link(burst))).toEqual({ kind: "wake" });
  });

  test("treats an edit or a failed reply as new, and only what came after the last wake", () => {
    const updated = { ...read(NOW - 20 * MINUTE), attention: "updated", changedAt: NOW } as const;
    const failed = { ...updated, attention: "reply_failed" } as const;
    for (const request of [updated, failed]) {
      const decision = decideWake(NOW, link([request], [ran(NOW - 20 * MINUTE)]));
      expect(decision).toEqual({ kind: "wait", until: NOW + 10 * SECOND });
    }
    // An old unread request doesn't hurry the burst that arrived since.
    const requests = [open(NOW - 5 * MINUTE), open(NOW - 2 * SECOND)];
    expect(decideWake(NOW, link(requests, [ran(NOW - 4 * MINUTE)]))).toEqual({
      kind: "wait",
      until: NOW + 8 * SECOND,
    });
  });

  test("wakes again 3, 6 and 12 minutes after wakes that left requests unread, then stalls", () => {
    const request = open(NOW - 30 * MINUTE);
    const runs: WakeRun[] = [];
    for (const wait of [3, 6, 12]) {
      runs.unshift(ran(NOW - MINUTE));
      expect(decideWake(NOW, link([request], runs))).toEqual({
        kind: "wait",
        until: NOW + (wait - 1) * MINUTE,
      });
    }
    runs.unshift(ran(NOW));
    expect(runs).toHaveLength(STALL_AFTER);
    expect(decideWake(NOW + HOUR, link([request], runs))).toEqual({ kind: "stalled" });
    expect(decideWake(NOW + HOUR, link([request, open(NOW + HOUR)], runs)).kind).toBe("wait");
  });

  test("reminds the lead once of a request it read and left, unless it was woken since", () => {
    const request = read(NOW - 30 * MINUTE);
    const woken = [ran(NOW - 31 * MINUTE)];
    expect(decideWake(NOW - MINUTE, link([request], woken))).toEqual({ kind: "wait", until: NOW });
    expect(decideWake(NOW, link([request], woken))).toEqual({ kind: "wake" });
    expect(decideWake(NOW, link([request], [ran(NOW - 10 * MINUTE)]))).toEqual({ kind: "idle" });
  });

  test("retries a run Toy Box didn't take, after 15 seconds doubling up to 5 minutes", () => {
    expect([1, 2, 3, 5, 6, 20].map((failures) => retryDelay(failures) / SECOND)).toEqual([
      15, 30, 60, 240, 300, 300,
    ]);
    const runs: WakeRun[] = [
      { at: NOW, outcome: "missing" },
      { at: NOW - 15 * SECOND, outcome: "failed" },
      ran(NOW - HOUR),
    ];
    expect(decideWake(NOW, link([open(NOW - MINUTE)], runs))).toEqual({
      kind: "wait",
      until: NOW + 30 * SECOND,
    });
  });

  test("waits for something new after Toy Box refuses a run", () => {
    const runs: WakeRun[] = [{ at: NOW - HOUR, outcome: "refused" }];
    expect(decideWake(NOW, link([open(NOW - 2 * HOUR)], runs))).toEqual({ kind: "blocked" });
    expect(decideWake(NOW, link([open(NOW - 2 * HOUR), open(NOW - MINUTE)], runs))).toEqual({
      kind: "wake",
    });
  });

  test("wakes a lead at most 12 times an hour", () => {
    const runs = Array.from({ length: WAKES_PER_HOUR }, (_, index) => ran(NOW - index * MINUTE));
    expect(decideWake(NOW + MINUTE, link([open(NOW + 30 * SECOND)], runs))).toEqual({
      kind: "wait",
      until: NOW - (WAKES_PER_HOUR - 1) * MINUTE + HOUR,
    });
  });

  test("leaves a link alone while it's paused or nothing waits", () => {
    expect(decideWake(NOW, { ...link([open(NOW - MINUTE)]), active: false })).toEqual({
      kind: "idle",
    });
    expect(decideWake(NOW, link([], [ran(NOW - MINUTE)]))).toEqual({ kind: "idle" });
  });
});

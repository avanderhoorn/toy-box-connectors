import { describe, expect, test } from "bun:test";
import {
  decideWake,
  retryDelay,
  STALL_AFTER,
  WAKES_PER_HOUR,
  type WakeDecision,
  type WakeRequest,
  type WakeRun,
} from ".";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const unread = { state: "open", attention: null, touchedAt: null } as const;
const open = (changedAt: number): WakeRequest => ({ ...unread, changedAt });
const read = (at: number): WakeRequest => ({ ...open(at), state: "seen", touchedAt: at });
const run = (at: number, outcome: WakeRun["outcome"]): WakeRun => ({ at, outcome });
const ran = (at: number) => run(at, "ran");
const waitUntil = (until: number): WakeDecision => ({ kind: "wait", until });

function decide(at: number, requests: WakeRequest[], runs: WakeRun[] = []): WakeDecision {
  return decideWake(at, { active: true, requests, suspendedAt: null, runs });
}

describe("deciding whether to wake a link's lead", () => {
  test("waits for a burst to settle, at most 30 seconds after its first change", () => {
    expect(decide(NOW, [open(NOW - 4 * SECOND)])).toEqual(waitUntil(NOW + 6 * SECOND));
    expect(decide(NOW, [open(NOW - 10 * SECOND)])).toEqual({ kind: "wake" });
    const burst = [0, 8, 16, 24].map((seconds) => open(NOW - 30 * SECOND + seconds * SECOND));
    expect(decide(NOW, burst)).toEqual({ kind: "wake" });
  });

  test("treats an edit or a failed reply as new, and only what came after the last wake", () => {
    const woken = [ran(NOW - 20 * MINUTE)];
    for (const attention of ["updated", "reply_failed"] as const) {
      const request = { ...read(NOW - 20 * MINUTE), attention, changedAt: NOW };
      expect(decide(NOW, [request], woken)).toEqual(waitUntil(NOW + 10 * SECOND));
    }
    // An old unread request doesn't hurry the burst that arrived since.
    const requests = [open(NOW - 5 * MINUTE), open(NOW - 2 * SECOND)];
    expect(decide(NOW, requests, [ran(NOW - 4 * MINUTE)])).toEqual(waitUntil(NOW + 8 * SECOND));
  });

  test("wakes again 3, 6 and 12 minutes after wakes that left requests unread, then stalls", () => {
    const request = open(NOW - 30 * MINUTE);
    const runs: WakeRun[] = [];
    for (const wait of [3, 6, 12]) {
      runs.unshift(ran(NOW - MINUTE));
      expect(decide(NOW, [request], runs)).toEqual(waitUntil(NOW + (wait - 1) * MINUTE));
    }
    runs.unshift(ran(NOW));
    expect(runs).toHaveLength(STALL_AFTER);
    expect(decide(NOW + HOUR, [request], runs)).toEqual({ kind: "stalled" });
    expect(decide(NOW + HOUR, [request, open(NOW + HOUR)], runs).kind).toBe("wait");
  });

  test("reminds the lead once of a request it read and left, unless it was woken since", () => {
    const request = read(NOW - 30 * MINUTE);
    const woken = [ran(NOW - 31 * MINUTE)];
    expect(decide(NOW - MINUTE, [request], woken)).toEqual(waitUntil(NOW));
    expect(decide(NOW, [request], woken)).toEqual({ kind: "wake" });
    expect(decide(NOW, [request], [ran(NOW - 10 * MINUTE)])).toEqual({ kind: "idle" });
  });

  test("retries a run Toy Box didn't take, after 15 seconds doubling up to 5 minutes", () => {
    expect([1, 2, 3, 6, 20].map((n) => retryDelay(n) / SECOND)).toEqual([15, 30, 60, 300, 300]);
    const runs = [run(NOW, "missing"), run(NOW - 15 * SECOND, "failed"), ran(NOW - HOUR)];
    expect(decide(NOW, [open(NOW - MINUTE)], runs)).toEqual(waitUntil(NOW + 30 * SECOND));
  });

  test("waits for something new after Toy Box refuses a run", () => {
    const runs = [run(NOW - HOUR, "refused")];
    expect(decide(NOW, [open(NOW - 2 * HOUR)], runs)).toEqual({ kind: "blocked" });
    expect(decide(NOW, [open(NOW - 2 * HOUR), open(NOW - MINUTE)], runs)).toEqual({ kind: "wake" });
  });

  test("wakes a lead at most 12 times an hour", () => {
    const runs = Array.from({ length: WAKES_PER_HOUR }, (_, index) => ran(NOW - index * MINUTE));
    const until = NOW - (WAKES_PER_HOUR - 1) * MINUTE + HOUR;
    expect(decide(NOW + MINUTE, [open(NOW + 30 * SECOND)], runs)).toEqual(waitUntil(until));
  });

  test("leaves a paused or quiet link alone, but wakes a suspended link's lead once", () => {
    const requests = [open(NOW - MINUTE), read(NOW - HOUR)];
    const paused = { active: false, requests, suspendedAt: null, runs: [] };
    expect(decideWake(NOW, paused)).toEqual({ kind: "idle" });
    expect(decide(NOW, [], [ran(NOW - MINUTE)])).toEqual({ kind: "idle" });
    const suspended = { ...paused, suspendedAt: NOW - MINUTE };
    expect(decideWake(NOW, suspended)).toEqual({ kind: "wake" });
    // The wake covers the suspension, and the requests wait for the link.
    expect(decideWake(NOW, { ...suspended, runs: [ran(NOW - SECOND)] })).toEqual({ kind: "idle" });
  });
});

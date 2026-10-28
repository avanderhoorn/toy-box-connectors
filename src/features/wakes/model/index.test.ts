import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wakeBudget, type WakeBudget } from "./budget";
import {
  catchUpPeriod,
  decideCatchUp,
  decideWake,
  dueReminders,
  retryDelay,
  wakeBlock,
  type LinkWakeState,
  type ToyBoxView,
  type WakeRequest,
} from ".";

const now = Date.parse("2026-10-27T16:00:00.000Z");
const seconds = (count: number) => now + count * 1_000;
const minutes = (count: number) => now + count * 60_000;

const open = wakeBudget([]);
const idleLead: ToyBoxView = { connected: true, provider: "copilot", leadWorking: false };
const workingLead: ToyBoxView = { ...idleLead, leadWorking: true };

function request(changes: Partial<WakeRequest> = {}): WakeRequest {
  return {
    id: 1,
    state: "open",
    attention: null,
    heldAt: null,
    changedAt: minutes(-5),
    seenAt: null,
    touchedAt: null,
    remindedAt: null,
    ...changes,
  };
}

function link(changes: Partial<LinkWakeState> = {}): LinkWakeState {
  return {
    id: "link-1",
    status: "active",
    routineState: "present",
    blockedReason: null,
    requests: [],
    lastWakeAt: null,
    lastInboxAt: null,
    wakesSinceInbox: 0,
    retryAt: null,
    ...changes,
  };
}

function slotAt(at: number): WakeBudget {
  return { nextSlot: (_linkId, from) => Math.max(from, at) };
}

describe("deciding whether to wake a link's lead", () => {
  describe("blocks", () => {
    test.each(["paused", "suspended"] as const)("a %s link", (status) => {
      expect(decideWake(now, link({ status, requests: [request()] }), idleLead, open)).toEqual({
        kind: "blocked",
        reason: "link_inactive",
      });
    });

    test("a link whose requests routine is missing, but not one that only drifted", () => {
      const pending = [request()];
      expect(
        decideWake(now, link({ routineState: "missing", requests: pending }), idleLead, open),
      ).toEqual({ kind: "blocked", reason: "routine_missing" });
      expect(
        decideWake(now, link({ routineState: "drifted", requests: pending }), idleLead, open),
      ).toEqual({ kind: "wake", reason: "requests" });
    });

    test("a lead that doesn't run on Copilot", () => {
      expect(
        decideWake(now, link({ requests: [request()] }), { ...idleLead, provider: "claude" }, open),
      ).toEqual({ kind: "blocked", reason: "provider" });
    });

    test("a link whose last run Toy Box refused", () => {
      expect(
        decideWake(now, link({ blockedReason: "refused", requests: [request()] }), idleLead, open),
      ).toEqual({ kind: "blocked", reason: "refused" });
    });

    test("even with nothing to wake for, so status can say why", () => {
      expect(decideWake(now, link({ status: "paused" }), idleLead, open)).toEqual({
        kind: "blocked",
        reason: "link_inactive",
      });
    });
  });

  describe("stays idle", () => {
    test("with no requests and nothing owed", () => {
      expect(decideWake(now, link(), idleLead, open)).toEqual({ kind: "idle" });
    });

    test("when the lead has seen every request and none needs it again yet", () => {
      const seen = request({ state: "seen", seenAt: minutes(-10), changedAt: minutes(-10) });
      expect(decideWake(now, link({ requests: [seen] }), workingLead, open)).toEqual({
        kind: "idle",
      });
    });

    test("for a held request, which gets no reminders", () => {
      const held = request({ state: "seen", seenAt: minutes(-60), heldAt: minutes(-50) });
      expect(decideWake(now, link({ requests: [held] }), idleLead, open)).toEqual({
        kind: "idle",
      });
    });

    test("whatever Toy Box's state, since there's nothing to wake for", () => {
      const down: ToyBoxView = { connected: false, provider: null, leadWorking: false };
      expect(decideWake(now, link({ retryAt: minutes(1) }), down, open)).toEqual({ kind: "idle" });
    });
  });

  describe("waits for Toy Box", () => {
    test("while the channel's stream isn't connected", () => {
      const down = { ...idleLead, connected: false };
      expect(decideWake(now, link({ requests: [request()] }), down, open)).toEqual({
        kind: "wait",
        until: "toy_box",
      });
    });

    test("until the stream has said which provider the lead runs on", () => {
      const unknown = { ...idleLead, provider: null };
      expect(decideWake(now, link({ requests: [request()] }), unknown, open)).toEqual({
        kind: "wait",
        until: "toy_box",
      });
    });

    test("until a failed run's retry is due", () => {
      const pending = { requests: [request()] };
      expect(decideWake(now, link({ ...pending, retryAt: seconds(30) }), idleLead, open)).toEqual({
        kind: "wait",
        until: seconds(30),
      });
      expect(decideWake(now, link({ ...pending, retryAt: now }), idleLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });
  });

  describe("requests", () => {
    test("an open request wakes the lead 10 seconds after it changed", () => {
      const fresh = link({ requests: [request({ changedAt: seconds(-4) })] });
      expect(decideWake(now, fresh, idleLead, open)).toEqual({ kind: "wait", until: seconds(6) });
      expect(decideWake(seconds(6), fresh, idleLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });

    test("a request the lead has seen wakes it again once it needs attention", () => {
      const updated = request({ state: "in_progress", attention: "updated", seenAt: minutes(-9) });
      expect(decideWake(now, link({ requests: [updated] }), idleLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });

    test("one wake covers a burst, 10 seconds after the latest and at most 30 after the oldest", () => {
      const burst = (oldest: number) =>
        link({
          requests: [
            request({ changedAt: oldest }),
            request({ changedAt: seconds(-6) }),
            request({ changedAt: seconds(-1) }),
          ],
        });
      expect(decideWake(now, burst(seconds(-12)), idleLead, open)).toEqual({
        kind: "wait",
        until: seconds(9),
      });
      expect(decideWake(now, burst(seconds(-25)), idleLead, open)).toEqual({
        kind: "wait",
        until: seconds(5),
      });
    });

    test("a wake inbox didn't follow is retried after 3, 6, then 12 minutes", () => {
      const lost = (wakesSinceInbox: number) =>
        link({
          requests: [request({ changedAt: minutes(-20) })],
          lastWakeAt: minutes(-1),
          wakesSinceInbox,
        });
      expect(decideWake(now, lost(1), idleLead, open)).toEqual({ kind: "wait", until: minutes(2) });
      expect(decideWake(now, lost(2), idleLead, open)).toEqual({ kind: "wait", until: minutes(5) });
      expect(decideWake(now, lost(3), idleLead, open)).toEqual({
        kind: "wait",
        until: minutes(11),
      });
      expect(decideWake(minutes(11), lost(3), idleLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });

    test("a request that changed since the last wake skips the backoff", () => {
      const changed = link({
        requests: [request({ changedAt: minutes(-20) }), request({ changedAt: seconds(-30) })],
        lastWakeAt: minutes(-1),
        wakesSinceInbox: 3,
      });
      expect(decideWake(now, changed, idleLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });

    test("after four wakes without an inbox call the link stalls until something new arrives", () => {
      const stalled = link({
        requests: [request({ changedAt: minutes(-60) })],
        lastWakeAt: minutes(-30),
        wakesSinceInbox: 4,
      });
      expect(decideWake(now, stalled, idleLead, open)).toEqual({ kind: "stalled" });
      const arrived = { ...stalled, requests: [...stalled.requests, request()] };
      expect(decideWake(now, arrived, idleLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });

    test("a working lead that read inbox after the requests changed is left to finish", () => {
      const read = link({
        requests: [request({ changedAt: minutes(-5) })],
        lastInboxAt: minutes(-4),
      });
      expect(decideWake(now, read, workingLead, open)).toEqual({
        kind: "wait",
        until: "lead_idle",
      });
    });

    test("a working lead that hasn't read them gets 2 minutes before the wake steers into its turn", () => {
      const unread = link({
        requests: [request({ changedAt: seconds(-30) })],
        lastInboxAt: minutes(-4),
      });
      expect(decideWake(now, unread, workingLead, open)).toEqual({
        kind: "wait",
        until: seconds(90),
      });
      expect(decideWake(seconds(90), unread, workingLead, open)).toEqual({
        kind: "wake",
        reason: "requests",
      });
    });

    test("waits for the budget", () => {
      expect(
        decideWake(now, link({ requests: [request()] }), idleLead, slotAt(minutes(7))),
      ).toEqual({ kind: "wait", until: minutes(7) });
    });
  });

  describe("reminders", () => {
    test("a request seen 30 minutes ago with no progress wakes the lead once", () => {
      const seen = request({ state: "seen", seenAt: minutes(-30), changedAt: minutes(-40) });
      expect(decideWake(now, link({ requests: [seen] }), idleLead, open)).toEqual({
        kind: "wake",
        reason: "reminder",
      });
      const reminded = { ...seen, remindedAt: now };
      expect(decideWake(minutes(5), link({ requests: [reminded] }), idleLead, open)).toEqual({
        kind: "idle",
      });
    });

    test("waits for the next reminder that comes due", () => {
      const seen = request({ state: "seen", seenAt: minutes(-20), changedAt: minutes(-40) });
      expect(decideWake(now, link({ requests: [seen] }), idleLead, open)).toEqual({
        kind: "wait",
        until: minutes(10),
      });
    });

    test("an in-progress request quiet for 2 hours wakes the lead, counted from its last touch", () => {
      const quiet = request({
        state: "in_progress",
        seenAt: minutes(-300),
        touchedAt: minutes(-120),
        remindedAt: minutes(-200),
      });
      expect(decideWake(now, link({ requests: [quiet] }), idleLead, open)).toEqual({
        kind: "wake",
        reason: "reminder",
      });
      expect(
        decideWake(
          now,
          link({ requests: [{ ...quiet, touchedAt: minutes(-90) }] }),
          idleLead,
          open,
        ),
      ).toEqual({ kind: "wait", until: minutes(30) });
    });

    test("never while the lead works", () => {
      const seen = request({ state: "seen", seenAt: minutes(-30), changedAt: minutes(-40) });
      expect(decideWake(now, link({ requests: [seen] }), workingLead, open)).toEqual({
        kind: "idle",
      });
    });

    test("follow the backoff and the stall like requests", () => {
      const seen = request({ state: "seen", seenAt: minutes(-30), changedAt: minutes(-40) });
      expect(
        decideWake(
          now,
          link({ requests: [seen], lastWakeAt: minutes(-1), wakesSinceInbox: 1 }),
          idleLead,
          open,
        ),
      ).toEqual({ kind: "wait", until: minutes(2) });
      expect(
        decideWake(
          now,
          link({ requests: [seen], lastWakeAt: minutes(-20), wakesSinceInbox: 4 }),
          idleLead,
          open,
        ),
      ).toEqual({ kind: "stalled" });
    });
  });
});

describe("blocking wakes", () => {
  test("names the first reason a person must act on", () => {
    const refused = { status: "paused", blockedReason: "refused" } as const;
    expect(wakeBlock(refused, "missing", "claude")).toBe("link_inactive");
    expect(wakeBlock({ ...refused, status: "active" }, "missing", "claude")).toBe(
      "routine_missing",
    );
    expect(wakeBlock({ ...refused, status: "active" }, "drifted", "claude")).toBe("provider");
    expect(wakeBlock({ ...refused, status: "active" }, "present", null)).toBe("refused");
    expect(wakeBlock({ status: "active", blockedReason: null }, "present", "copilot")).toBeNull();
  });
});

describe("catching up a publication", () => {
  const owed = { scheduledAt: minutes(-150), routineState: "present" } as const;
  const linked = link();

  test("runs the series' routine once its run is 2 hours old and the lead is idle", () => {
    expect(decideCatchUp(now, owed, linked, idleLead, open)).toEqual({
      kind: "wake",
      reason: "catch_up",
    });
    expect(
      decideCatchUp(now, { ...owed, scheduledAt: minutes(-90) }, linked, idleLead, open),
    ).toEqual({ kind: "wait", until: minutes(30) });
  });

  test("waits for a working lead to go idle", () => {
    expect(decideCatchUp(now, owed, linked, workingLead, open)).toEqual({
      kind: "wait",
      until: "lead_idle",
    });
  });

  test("is blocked by the series' own routine, whatever the requests routine's state", () => {
    expect(
      decideCatchUp(now, { ...owed, routineState: "missing" }, linked, idleLead, open),
    ).toEqual({ kind: "blocked", reason: "routine_missing" });
    const missingRequests = link({ routineState: "missing" });
    expect(decideCatchUp(now, owed, missingRequests, idleLead, open)).toEqual({
      kind: "wake",
      reason: "catch_up",
    });
  });

  test("is blocked like any wake by the link, the provider and a refusal", () => {
    expect(decideCatchUp(now, owed, link({ status: "paused" }), idleLead, open)).toEqual({
      kind: "blocked",
      reason: "link_inactive",
    });
    expect(decideCatchUp(now, owed, linked, { ...idleLead, provider: "claude" }, open)).toEqual({
      kind: "blocked",
      reason: "provider",
    });
    expect(decideCatchUp(now, owed, link({ blockedReason: "refused" }), idleLead, open)).toEqual({
      kind: "blocked",
      reason: "refused",
    });
  });

  test("waits for Toy Box, a failed run's retry and the budget", () => {
    expect(decideCatchUp(now, owed, linked, { ...idleLead, connected: false }, open)).toEqual({
      kind: "wait",
      until: "toy_box",
    });
    expect(decideCatchUp(now, owed, link({ retryAt: seconds(30) }), idleLead, open)).toEqual({
      kind: "wait",
      until: seconds(30),
    });
    expect(decideCatchUp(now, owed, linked, idleLead, slotAt(minutes(4)))).toEqual({
      kind: "wait",
      until: minutes(4),
    });
  });
});

describe("reminders that are due", () => {
  test("are the unheld requests quiet past their reminder since the lead last touched them", () => {
    const due = [
      request({ state: "seen", seenAt: minutes(-30) }),
      request({ state: "in_progress", seenAt: minutes(-500), touchedAt: minutes(-120) }),
      request({
        state: "seen",
        seenAt: minutes(-90),
        touchedAt: minutes(-31),
        remindedAt: minutes(-60),
      }),
    ];
    const notDue = [
      request({ state: "open" }),
      request({ state: "seen", seenAt: minutes(-29) }),
      request({ state: "in_progress", touchedAt: minutes(-119) }),
      request({ state: "seen", seenAt: minutes(-60), remindedAt: minutes(-30) }),
      request({ state: "seen", seenAt: minutes(-60), heldAt: minutes(-40) }),
      request({ state: "seen" }),
    ];
    expect(dueReminders(now, [...due, ...notDue])).toEqual(due);
  });
});

describe("retrying a failed run", () => {
  test.each([
    [1, 15_000],
    [2, 30_000],
    [3, 60_000],
    [5, 240_000],
    [6, 300_000],
    [12, 300_000],
  ])("after %i failures in a row waits %i ms", (failures, delay) => {
    expect(retryDelay(failures)).toBe(delay);
  });
});

describe("the period a series may catch up", () => {
  // Schedules run in local time, so these tests pin a zone.
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  const local = (value: string) => new Date(value).getTime();
  const standup = { series: "standup", period: "day", schedule: "0 16 * * 1-5" } as const;

  test("is the one the latest scheduled run started", () => {
    const series = { ...standup, registeredAt: local("2026-10-20T09:00:00") };
    expect(catchUpPeriod(series, local("2026-10-28T09:00:00"))).toEqual({
      scheduledAt: local("2026-10-27T16:00:00"),
      key: "standup/2026-10-27",
    });
  });

  test("starts with the first run at or after the series was registered", () => {
    const at = local("2026-10-28T09:00:00");
    const scheduledAt = local("2026-10-27T16:00:00");
    expect(catchUpPeriod({ ...standup, registeredAt: scheduledAt }, at)).toEqual({
      scheduledAt,
      key: "standup/2026-10-27",
    });
    expect(catchUpPeriod({ ...standup, registeredAt: scheduledAt + 1 }, at)).toBeNull();
  });

  test("doesn't exist for a schedule that can't run", () => {
    const series = { ...standup, schedule: "0 9 31 2 *", registeredAt: 0 };
    expect(catchUpPeriod(series, local("2026-10-28T09:00:00"))).toBeNull();
  });
});

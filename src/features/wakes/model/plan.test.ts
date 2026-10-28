import { describe, expect, test } from "bun:test";
import { WAKES_PER_HOUR, type RanWake } from "./budget";
import type { ToyBoxView, WakeRequest } from ".";
import { planWakes, type OwedCatchUp, type ScheduledLink } from "./plan";

const now = Date.parse("2026-10-27T16:00:00.000Z");
const seconds = (count: number) => now + count * 1_000;
const minutes = (count: number) => now + count * 60_000;

const idleLead: ToyBoxView = { connected: true, provider: "copilot", leadWorking: false };
const workingLead: ToyBoxView = { ...idleLead, leadWorking: true };
const idle = () => idleLead;
const notBusy = new Map<string, number>();

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

function scheduled(changes: Partial<ScheduledLink> = {}): ScheduledLink {
  return {
    id: "link-1",
    channelId: "channel-1",
    routineId: "routine-requests",
    status: "active",
    routineState: "present",
    blockedReason: null,
    requests: [],
    lastWakeAt: null,
    lastInboxAt: null,
    wakesSinceInbox: 0,
    retryAt: null,
    catchUps: [],
    ...changes,
  };
}

function catchUp(changes: Partial<OwedCatchUp> = {}): OwedCatchUp {
  return {
    series: "standup",
    routineId: "routine-standup",
    routineState: "present",
    scheduledAt: minutes(-150),
    key: "standup/2026-10-27",
    ...changes,
  };
}

type Pass = { links?: ScheduledLink[]; ran?: RanWake[] };

function planPass(
  pass: Pass,
  toyBox: (channelId: string) => ToyBoxView = idle,
  busyUntil: ReadonlyMap<string, number> = notBusy,
  slackUsable = true,
) {
  return planWakes(
    now,
    { links: pass.links ?? [], ran: pass.ran ?? [] },
    slackUsable,
    toyBox,
    busyUntil,
  );
}

/** The pass's runs and next decision, leaving its decisions to the tests about them. */
function plan(...args: Parameters<typeof planPass>) {
  const { wakes, decideAt } = planPass(...args);
  return { wakes, decideAt };
}

describe("planning a pass", () => {
  test("runs a link's requests routine, delivering the reminders an idle lead is owed", () => {
    const link = scheduled({
      requests: [
        request({ id: 1 }),
        request({ id: 2, state: "seen", seenAt: minutes(-31) }),
        request({ id: 3, state: "seen", seenAt: minutes(-10) }),
      ],
    });
    expect(plan({ links: [link] })).toEqual({
      wakes: [
        {
          kind: "requests",
          channelId: "channel-1",
          routineId: "routine-requests",
          linkId: "link-1",
          catchUp: null,
          reminded: [2],
        },
      ],
      decideAt: null,
    });
  });

  test("delivers no reminders into a working lead's turn", () => {
    const link = scheduled({
      requests: [
        request({ id: 1, changedAt: minutes(-3) }),
        request({ id: 2, state: "seen", seenAt: minutes(-31) }),
      ],
    });
    const { wakes } = plan({ links: [link] }, () => workingLead);
    expect(wakes.map(({ kind, reminded }) => ({ kind, reminded }))).toEqual([
      { kind: "requests", reminded: [] },
    ]);
  });

  test("decides again at the earliest time any wait ends", () => {
    const debounced = scheduled({ requests: [request({ changedAt: seconds(-4) })] });
    const retrying = scheduled({
      id: "link-2",
      channelId: "channel-2",
      requests: [request()],
      retryAt: seconds(3),
    });
    expect(plan({ links: [debounced, retrying] })).toEqual({ wakes: [], decideAt: seconds(3) });
  });

  test("sets no timer for a link that waits on something else to change", () => {
    const links = [
      scheduled({ id: "idle" }),
      scheduled({
        id: "stalled",
        requests: [request({ changedAt: minutes(-60) })],
        lastWakeAt: minutes(-30),
        wakesSinceInbox: 4,
      }),
      scheduled({ id: "blocked", status: "paused", requests: [request()] }),
      scheduled({ id: "unreachable", channelId: "channel-down", requests: [request()] }),
      scheduled({
        id: "working",
        channelId: "channel-working",
        requests: [request()],
        lastInboxAt: minutes(-1),
      }),
    ];
    const toyBox = (channelId: string) =>
      channelId === "channel-down"
        ? { ...idleLead, connected: false }
        : channelId === "channel-working"
          ? workingLead
          : idleLead;
    expect(plan({ links }, toyBox)).toEqual({ wakes: [], decideAt: null });
  });

  test("keeps what it decided for each link whose channel isn't busy, for status to show", () => {
    const due = scheduled({ requests: [request()] });
    const debounced = scheduled({
      id: "link-2",
      channelId: "channel-2",
      requests: [request({ changedAt: seconds(-4) })],
    });
    const stalled = scheduled({
      id: "link-3",
      channelId: "channel-3",
      requests: [request({ changedAt: minutes(-60) })],
      lastWakeAt: minutes(-30),
      wakesSinceInbox: 4,
    });
    const busy = scheduled({ id: "link-4", channelId: "channel-4", requests: [request()] });
    const inFlight = new Map([["channel-4", Infinity]]);
    const { decisions } = planPass({ links: [due, debounced, stalled, busy] }, idle, inFlight);
    expect(Object.fromEntries(decisions)).toEqual({
      "link-1": { kind: "wake", reason: "requests" },
      "link-2": { kind: "wait", until: seconds(6) },
      "link-3": { kind: "stalled" },
    });
  });

  describe("wakes nobody while the bridge can't use Slack, since a woken lead couldn't act", () => {
    test("so each wake waits for Slack instead", () => {
      const due = scheduled({ requests: [request()] });
      const owed = scheduled({ id: "link-2", channelId: "channel-2", catchUps: [catchUp()] });
      const pass = { links: [due, owed] };
      expect(plan(pass).wakes.map(({ kind }) => kind)).toEqual(["requests", "catch_up"]);

      const { wakes, decisions, decideAt } = planPass(pass, idle, notBusy, false);
      expect({ wakes, decideAt }).toEqual({ wakes: [], decideAt: null });
      expect(Object.fromEntries(decisions)).toEqual({
        "link-1": { kind: "wait", until: "slack" },
        "link-2": { kind: "idle" },
      });
    });

    test("and every other decision stands, deciding again when a wait ends", () => {
      const debounced = scheduled({ requests: [request({ changedAt: seconds(-4) })] });
      const stalled = scheduled({
        id: "link-2",
        channelId: "channel-2",
        requests: [request({ changedAt: minutes(-60) })],
        lastWakeAt: minutes(-30),
        wakesSinceInbox: 4,
      });
      const paused = scheduled({
        id: "link-3",
        channelId: "channel-3",
        status: "paused",
        requests: [request()],
      });
      const { decisions, decideAt } = planPass(
        { links: [debounced, stalled, paused] },
        idle,
        notBusy,
        false,
      );
      expect(Object.fromEntries(decisions)).toEqual({
        "link-1": { kind: "wait", until: seconds(6) },
        "link-2": { kind: "stalled" },
        "link-3": { kind: "blocked", reason: "link_inactive" },
      });
      expect(decideAt).toBe(seconds(6));
    });
  });

  describe("runs at most one routine per channel", () => {
    test("and none while a run is in flight, deciding again when it lands", () => {
      const link = scheduled({ requests: [request()] });
      const inFlight = new Map([["channel-1", Infinity]]);
      expect(plan({ links: [link] }, idle, inFlight)).toEqual({ wakes: [], decideAt: null });
    });

    test("and none until a run that landed has had time to show its turn", () => {
      const link = scheduled({ requests: [request()] });
      const settling = new Map([["channel-1", seconds(4)]]);
      expect(plan({ links: [link] }, idle, settling)).toEqual({ wakes: [], decideAt: seconds(4) });
      const settled = new Map([["channel-1", now]]);
      expect(plan({ links: [link] }, idle, settled).wakes).toHaveLength(1);
    });

    test("so a catch-up waits for a pass where its link owes nothing else", () => {
      const owed = scheduled({ requests: [request()], catchUps: [catchUp()] });
      expect(plan({ links: [owed] }).wakes.map(({ kind }) => kind)).toEqual(["requests"]);
      expect(plan({ links: [{ ...owed, requests: [] }] }).wakes).toEqual([
        {
          kind: "catch_up",
          channelId: "channel-1",
          routineId: "routine-standup",
          linkId: "link-1",
          catchUp: { series: "standup", key: "standup/2026-10-27" },
          reminded: [],
        },
      ]);
    });

    test("and catches up one period at a time", () => {
      const link = scheduled({
        catchUps: [
          catchUp({ routineState: "missing" }),
          catchUp({ series: "notes", routineId: "routine-notes", key: "notes/2026-10-26" }),
          catchUp({ series: "digest", routineId: "routine-digest", key: "digest/2026-10-27" }),
        ],
      });
      const { wakes } = plan({ links: [link] });
      expect(wakes.map(({ catchUp }) => catchUp)).toEqual([
        { series: "notes", key: "notes/2026-10-26" },
      ]);
    });
  });

  test("counts the runs it starts against the budget", () => {
    const ran = Array.from({ length: WAKES_PER_HOUR - 1 }, (_, index) => ({
      linkId: "link-old",
      at: minutes(-50 + index),
    }));
    const first = scheduled({ requests: [request()] });
    const second = scheduled({ id: "link-2", channelId: "channel-2", requests: [request()] });
    expect(plan({ links: [first, second], ran })).toEqual({
      wakes: [expect.objectContaining({ linkId: "link-1" })],
      decideAt: minutes(10),
    });
  });
});

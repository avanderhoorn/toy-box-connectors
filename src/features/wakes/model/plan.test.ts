import { describe, expect, test } from "bun:test";
import { WAKES_PER_HOUR, type RanWake } from "./budget";
import type { ToyBoxView, WakeRequest } from ".";
import { planWakes, type OwedCatchUp, type ProposalDebt, type ScheduledLink } from "./plan";

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
    setup: [],
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

function proposal(changes: Partial<ProposalDebt> = {}): ProposalDebt {
  return {
    approvalId: "approval-1",
    channelId: "channel-9",
    routineId: "routine-proposed",
    failures: { count: 0, lastAt: null },
    ...changes,
  };
}

type Pass = { links?: ScheduledLink[]; proposals?: ProposalDebt[]; ran?: RanWake[] };

function planPass(
  pass: Pass,
  toyBox: (channelId: string) => ToyBoxView = idle,
  busyUntil: ReadonlyMap<string, number> = notBusy,
) {
  return planWakes(
    now,
    { links: pass.links ?? [], proposals: pass.proposals ?? [], ran: pass.ran ?? [] },
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
          approvalId: null,
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

  test("names the oldest proposal a setup run tells the lead about", () => {
    const link = scheduled({
      setup: [
        { approvalId: "approval-1", decidedAt: seconds(-20) },
        { approvalId: "approval-2", decidedAt: seconds(-10) },
      ],
    });
    const { wakes } = plan({ links: [link] });
    expect(wakes.map(({ kind, approvalId }) => ({ kind, approvalId }))).toEqual([
      { kind: "setup", approvalId: "approval-1" },
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
          approvalId: null,
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

    test("and a channel's proposals run oldest first", () => {
      const proposals = [
        proposal({ approvalId: "approval-1" }),
        proposal({ approvalId: "approval-2" }),
        proposal({ approvalId: "approval-3", channelId: "channel-8", routineId: "routine-other" }),
      ];
      expect(plan({ proposals }).wakes).toEqual([
        {
          kind: "setup",
          channelId: "channel-9",
          routineId: "routine-proposed",
          linkId: null,
          approvalId: "approval-1",
          catchUp: null,
          reminded: [],
        },
        {
          kind: "setup",
          channelId: "channel-8",
          routineId: "routine-other",
          linkId: null,
          approvalId: "approval-3",
          catchUp: null,
          reminded: [],
        },
      ]);
    });
  });

  test("retries a proposal's failed run on the backoff", () => {
    const failed = proposal({ failures: { count: 2, lastAt: seconds(-10) } });
    expect(plan({ proposals: [failed] })).toEqual({ wakes: [], decideAt: seconds(20) });
  });

  test("counts the runs it starts against the budget", () => {
    const ran = Array.from({ length: WAKES_PER_HOUR - 1 }, (_, index) => ({
      linkId: "link-old",
      at: minutes(-50 + index),
    }));
    const first = scheduled({ requests: [request()] });
    const second = scheduled({ id: "link-2", channelId: "channel-2", requests: [request()] });
    expect(plan({ links: [first, second], proposals: [proposal()], ran })).toEqual({
      wakes: [expect.objectContaining({ linkId: "link-1" })],
      decideAt: minutes(10),
    });
  });
});

import { describe, expect, test } from "bun:test";
import { observeLeadPresence, restoreLine, type LeadPresence } from "./presence";

const waiting: LeadPresence = {
  state: "waiting",
  waiting: { text: "The owner's decision", wakeAt: Date.parse("2026-10-27T17:00:00.000Z") },
};

describe("observing the lead's presence", () => {
  test("a waiting lead keeps what it waits for and when Toy Box would wake it", () => {
    expect(
      observeLeadPresence(
        null,
        { state: "waiting", text: "The owner's decision", wakeAt: "2026-10-27T17:00:00.000Z" },
        true,
      ),
    ).toEqual(waiting);
    expect(observeLeadPresence(null, { state: "waiting", text: "CI" }, true)).toEqual({
      state: "waiting",
      waiting: { text: "CI", wakeAt: null },
    });
    expect(
      observeLeadPresence(null, { state: "waiting", text: "CI", wakeAt: "soon" }, true),
    ).toEqual({ state: "waiting", waiting: { text: "CI", wakeAt: null } });
  });

  test("a lead that starts working live keeps what it was waiting for", () => {
    expect(observeLeadPresence(waiting, { state: "working" }, true)).toEqual({
      state: "working",
      restore: waiting.waiting,
    });
  });

  test("a turn already under way keeps what it restores", () => {
    const working = observeLeadPresence(waiting, { state: "working" }, true);
    expect(observeLeadPresence(working, { state: "working", text: "Replying" }, true)).toEqual(
      working,
    );
    expect(observeLeadPresence(working, { state: "working" }, false)).toEqual(working);
  });

  test("a turn seen only after a gap restores nothing", () => {
    expect(observeLeadPresence(waiting, { state: "working" }, false)).toEqual({
      state: "working",
      restore: null,
    });
    expect(observeLeadPresence(null, { state: "working" }, true)).toEqual({
      state: "working",
      restore: null,
    });
    expect(observeLeadPresence({ state: "idle" }, { state: "working" }, true)).toEqual({
      state: "working",
      restore: null,
    });
  });

  test("a lead that finishes its turn restores nothing more", () => {
    const working = observeLeadPresence(waiting, { state: "working" }, true);
    expect(observeLeadPresence(working, { state: "idle" }, true)).toEqual({ state: "idle" });
    expect(observeLeadPresence(working, { state: "waiting", text: "CI" }, true)).toEqual({
      state: "waiting",
      waiting: { text: "CI", wakeAt: null },
    });
  });
});

describe("the restore line", () => {
  const now = Date.parse("2026-10-27T16:00:00.000Z");
  const minutes = (count: number) => now + count * 60_000;

  test("hands back what the lead waited for and the minutes left until its wake", () => {
    expect(restoreLine({ text: "The owner's decision", wakeAt: minutes(42) }, now)).toBe(
      `Before this turn you were waiting for "The owner's decision". If that's still true when you finish, call finish_agent_turn with that waitingFor and wakeAfterMinutes 42.`,
    );
  });

  test("leaves the wake out when the lead had none", () => {
    expect(restoreLine({ text: "CI", wakeAt: null }, now)).toBe(
      `Before this turn you were waiting for "CI". If that's still true when you finish, call finish_agent_turn with that waitingFor.`,
    );
  });

  test.each([
    ["rounds a partial minute up", minutes(41.2), 42],
    ["waits at least 5 minutes", minutes(1), 5],
    ["waits at least 5 minutes once the wake is due", minutes(-30), 5],
    ["waits at most 2 hours", minutes(600), 120],
  ])("%s", (_name, wakeAt, expected) => {
    expect(restoreLine({ text: "CI", wakeAt }, now)).toEndWith(` wakeAfterMinutes ${expected}.`);
  });
});

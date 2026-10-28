import { describe, expect, test } from "bun:test";
import { observeLeadPresence, restoreArguments, type LeadPresence } from "./presence";

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

describe("the restore arguments", () => {
  const now = Date.parse("2026-10-27T16:00:00.000Z");
  const minutes = (count: number) => now + count * 60_000;

  test("hand back what the lead waited for and the minutes left until its wake", () => {
    expect(restoreArguments({ text: "The owner's decision", wakeAt: minutes(42) }, now)).toEqual({
      waitingFor: "The owner's decision",
      wakeAfterMinutes: 42,
    });
  });

  test("leave the wake out when the lead had none", () => {
    expect(restoreArguments({ text: "CI", wakeAt: null }, now)).toEqual({
      waitingFor: "CI",
      wakeAfterMinutes: null,
    });
  });

  test.each([
    ["round a partial minute up", minutes(41.2), 42],
    ["wait at least 5 minutes", minutes(1), 5],
    ["wait at least 5 minutes once the wake is due", minutes(-30), 5],
    ["wait at most 2 hours", minutes(600), 120],
  ])("%s", (_name, wakeAt, expected) => {
    expect(restoreArguments({ text: "CI", wakeAt }, now).wakeAfterMinutes).toBe(expected);
  });
});

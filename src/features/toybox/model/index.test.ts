import { expect, test } from "bun:test";
import { findRoutine, latestScheduledRun, REQUESTS_COMMAND, routineRunOutcome } from ".";

test("the routine that wakes the lead is the first whose prompt runs inbox, however it's wrapped", () => {
  const routines = [
    { id: "check", prompt: "Check Slack." },
    { id: "plural", prompt: "Run toy-box-slack inboxes." },
    { id: "wrapped", prompt: "Run toy-box-slack\n  inbox, then answer." },
    { id: "quoted", prompt: "Run `toy-box-slack inbox` and answer." },
  ];

  expect(findRoutine(routines, REQUESTS_COMMAND)?.id).toBe("wrapped");
  expect(findRoutine(routines.slice(0, 2), REQUESTS_COMMAND)).toBeUndefined();
});

test("a routine's latest scheduled run is in local time and includes one at now", () => {
  const friday = new Date(2026, 9, 30, 16, 0).getTime();

  expect(latestScheduledRun("0 16 * * 5", friday)).toBe(friday);
  expect(latestScheduledRun("0 16 * * 5", friday - 1)).toBe(new Date(2026, 9, 23, 16, 0).getTime());
});

test("Toy Box answering a run with 404 means missing", () => {
  expect(routineRunOutcome(404)).toBe("missing");
});

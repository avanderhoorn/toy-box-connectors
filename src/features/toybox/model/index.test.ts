import { expect, test } from "bun:test";
import { findRoutine, REQUESTS_COMMAND, routineRunOutcome } from ".";

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

test.each([
  [204, "ran"],
  [404, "missing"],
  [400, "refused"],
  [422, "refused"],
  [500, "failed"],
  [503, "failed"],
] as const)("Toy Box answering a run with %i means %s", (status, outcome) => {
  expect(routineRunOutcome(status)).toBe(outcome);
});

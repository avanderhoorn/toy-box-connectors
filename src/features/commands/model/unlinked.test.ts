import { expect, test } from "bun:test";
import { deleteUnlinkedRoutines, notLinked } from "./unlinked";

test("tells the lead to delete the routines that would wake it for nothing", () => {
  expect(notLinked("lead")).toBe(
    "This Toy Box channel isn't linked to Slack. Unless the owner means to link it, use delete_routine on the routines here that run toy-box-slack, so they stop waking you for nothing.",
  );
});

test("says what having no link leaves the command, before the routines", () => {
  expect(notLinked("lead", "so it has no r14")).toBe(
    `This Toy Box channel isn't linked to Slack, so it has no r14. ${deleteUnlinkedRoutines}`,
  );
});

test.each([
  ["a member", "member"],
  ["the operator", "operator"],
] as const)("tells %s only that there's no link", (_, role) => {
  expect(notLinked(role)).toBe("This Toy Box channel isn't linked to Slack.");
  expect(notLinked(role, "so it has no r14")).toBe(
    "This Toy Box channel isn't linked to Slack, so it has no r14.",
  );
});

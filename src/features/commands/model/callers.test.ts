import { expect, test } from "bun:test";
import { resolveCaller, type CallerFacts, type CallerRole } from "./callers";

const LINKED = new Set(["toybox-link", "toybox-other"]);
const ANYONE: CallerRole[] = ["lead", "terminal"];

test.each<[string, CallerFacts, CallerRole, string | null]>([
  ["a linked channel's lead", { sessionId: "toybox-link", channelId: null }, "lead", "toybox-link"],
  [
    "a lead naming its own channel",
    { sessionId: "toybox-link", channelId: "toybox-link" },
    "lead",
    "toybox-link",
  ],
  [
    "a terminal naming a channel",
    { sessionId: null, channelId: "toybox-other" },
    "terminal",
    "toybox-other",
  ],
  ["a terminal naming none", { sessionId: null, channelId: null }, "terminal", null],
])("acts for %s", (_, facts, role, channelId) => {
  expect(resolveCaller(facts, LINKED, "status", ANYONE)).toEqual({
    kind: "caller",
    caller: { role, channelId },
  });
});

test.each<[string, CallerFacts, readonly CallerRole[], string]>([
  [
    "a session that leads no linked channel, such as a member's",
    { sessionId: "toybox-member", channelId: "toybox-link" },
    ANYONE,
    "This session isn't the lead of a Toy Box channel linked to Slack, so it can't use toy-box-slack. If you lead a channel whose link was removed, delete its routines that run toy-box-slack.",
  ],
  [
    "a lead naming another channel",
    { sessionId: "toybox-link", channelId: "toybox-other" },
    ANYONE,
    "A lead acts only for its own Toy Box channel. Run it again without --channel.",
  ],
  [
    "a terminal running a command only a lead runs",
    { sessionId: null, channelId: "toybox-link" },
    ["lead"],
    "Only the lead of a linked Toy Box channel runs `status`.",
  ],
])("refuses %s", (_, facts, callers, message) => {
  expect(resolveCaller(facts, LINKED, "status", callers)).toEqual({ kind: "refused", message });
});

import { expect, test } from "bun:test";
import { resolveCaller, resolveSessionId, type CallerFacts, type CallerRole } from "./callers";

const LINKED = new Set(["toybox-link", "toybox-other"]);
const ANYONE: CallerRole[] = ["lead", "terminal"];

test.each<[string, NodeJS.ProcessEnv, string | null]>([
  ["a session", { COPILOT_AGENT_SESSION_ID: "toybox-link" }, "toybox-link"],
  [
    "a session with spaces around it",
    { COPILOT_AGENT_SESSION_ID: " toybox-link\n" },
    "toybox-link",
  ],
  ["no session", {}, null],
  ["an empty session", { COPILOT_AGENT_SESSION_ID: "" }, null],
  ["a blank session", { COPILOT_AGENT_SESSION_ID: " " }, null],
])("reads %s from the environment", (_, env, sessionId) => {
  expect(resolveSessionId(env)).toBe(sessionId);
});

test.each<[string, CallerFacts, string | null]>([
  ["a linked channel's lead", { sessionId: "toybox-link", channelId: null }, "toybox-link"],
  [
    "a lead naming its own channel",
    { sessionId: "toybox-link", channelId: "toybox-link" },
    "toybox-link",
  ],
  ["a terminal naming a channel", { sessionId: null, channelId: "toybox-other" }, "toybox-other"],
  ["a terminal naming none", { sessionId: null, channelId: null }, null],
])("acts for %s", (_, facts, channelId) => {
  expect(resolveCaller(facts, LINKED, "status", ANYONE)).toEqual({ kind: "caller", channelId });
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

import { expect, test } from "bun:test";
import type { SlackCall } from "@slackapi/server/botClient";
import type { RequestState } from "@requests/model/lifecycle";
import { displayChange, judgeReaction, reactionChanges } from "./reactions";

test("a request shows 🏃 once read, neither once answered, and 👀 again if it ends unanswered", () => {
  const change = (before: RequestState, after: RequestState) =>
    displayChange({ state: before }, { state: after });
  expect(change("open", "seen")).toBe("runner");
  expect(change("answering", "answered")).toBe("bare");
  for (const after of ["dismissed", "cancelled", "expired"] as const)
    expect(change("seen", after)).toBe("eyes");
  expect(change("answering", "cancelled")).toBe("eyes");
});

test("a change that leaves what a request's message should show owes nothing", () => {
  const change = (before: RequestState, after: RequestState) =>
    displayChange({ state: before }, { state: after });
  // An edit, a reread, queueing a reply and a refused one all leave 🏃 or what a wake gave.
  for (const [before, after] of [
    ["open", "open"],
    ["seen", "seen"],
    ["seen", "answering"],
    ["answering", "seen"],
  ] as const)
    expect(change(before, after)).toBeNull();
  // One that ends before the lead read it keeps whatever a wake gave it.
  for (const after of ["cancelled", "expired"] as const) expect(change("open", after)).toBeNull();
});

test("a display adds what it shows before it removes what it doesn't", () => {
  expect(reactionChanges("eyes")).toEqual([
    { change: "add", name: "eyes" },
    { change: "remove", name: "runner" },
  ]);
  expect(reactionChanges("runner")).toEqual([
    { change: "add", name: "runner" },
    { change: "remove", name: "eyes" },
  ]);
  expect(reactionChanges("bare").map(({ change }) => change)).toEqual(["remove", "remove"]);
});

test("a reaction call Slack refused is done, and one it may not have run is tried again", () => {
  const error = (error: string): SlackCall<unknown> => ({
    kind: "error",
    error,
    data: { ok: false },
  });
  expect(judgeReaction({ kind: "ok", result: {} })).toBe("done");
  expect(judgeReaction(error("already_reacted"))).toBe("done");
  expect(judgeReaction(error("message_not_found"))).toBe("done");
  expect(judgeReaction(error("internal_error"))).toBe("unanswered");
  expect(judgeReaction({ kind: "unknown", detail: "timed out" })).toBe("unanswered");
  expect(judgeReaction({ kind: "rate_limited", until: 1 })).toBe("held");
  expect(judgeReaction({ kind: "auth_failed", error: "invalid_auth" })).toBe("held");
});

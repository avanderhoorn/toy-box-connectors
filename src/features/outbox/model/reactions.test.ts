import { expect, test } from "bun:test";
import type { SlackCall } from "@slackapi/server/botClient";
import {
  displayOf,
  judgeReaction,
  reactionChanges,
  type Display,
  type Standing,
} from "./reactions";

test("each standing shows one display, and answered shows neither reaction", () => {
  const shows: Record<Standing, Display> = {
    woken: "eyes",
    released: "eyes",
    working: "runner",
    answered: "bare",
  };
  for (const [standing, display] of Object.entries(shows))
    expect(displayOf(standing as Standing)).toBe(display);
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

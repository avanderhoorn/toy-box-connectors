import { expect, test } from "bun:test";
import { tsAt } from "@slackapi/model/ts";
import { catchUpWindow, changedSince } from "./catchUp";

test("catch-up takes changes from five minutes before a gap, but never before the link or 30 days ago", () => {
  const now = Date.UTC(2026, 9, 28, 9);
  const [oldest, beforeGap, linked] = [30 * 24 * 60, 6, 2].map((ago) => tsAt(now - ago * 60_000));
  expect(catchUpWindow(now - 60_000, tsAt(0), now)).toEqual({ oldest, from: beforeGap });
  expect(catchUpWindow(now - 60_000, linked, now).from).toBe(linked);
  expect(catchUpWindow(0, tsAt(0), now).from).toBe(oldest);
  expect(changedSince({ ts: oldest, edited: { ts: linked } }, linked)).toBe(true);
});

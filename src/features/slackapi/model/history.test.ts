import { expect, test } from "bun:test";
import { continueHistory, historyPageSchema } from "./history";

test("only exhausted cursors finish history, never short, missing or cyclic pages", () => {
  const page = historyPageSchema.parse({
    ok: true,
    messages: [],
    response_metadata: { next_cursor: "more" },
  });
  expect(continueHistory(page, new Set())).toEqual({ kind: "more", cursor: "more" });
  expect(continueHistory(page, new Set(["more"]))).toMatchObject({ kind: "incomplete" });
  expect(
    continueHistory({ messages: [], hasMore: true, nextCursor: null }, new Set()),
  ).toMatchObject({ kind: "incomplete" });
  expect(continueHistory({ messages: [], hasMore: false, nextCursor: null }, new Set())).toEqual({
    kind: "done",
  });
  expect(historyPageSchema.safeParse({ ok: true }).success).toBe(false);
});

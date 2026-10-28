import { expect, test } from "bun:test";
import { continueHistory, historyPageSchema } from "./history";

test("a history page preserves opaque metadata and additive message fields", () => {
  const message = {
    ts: "1.1",
    bot_profile: { app_id: "A-app" },
    metadata: { event_type: "toy_box_outbox", event_payload: { id: "opaque" } },
    future_field: { useful: true },
  };
  expect(
    historyPageSchema.parse({ ok: true, messages: [message], future_page_field: true }),
  ).toEqual({ messages: [message], hasMore: false, nextCursor: null });
});

test.each([
  {},
  { ok: false, messages: [] },
  { ok: true },
  { ok: true, messages: null },
  { ok: true, messages: {}, has_more: false },
  { ok: true, messages: [], has_more: "false" },
  { ok: true, messages: [], response_metadata: { next_cursor: 4 } },
])("a malformed history page is not a successful empty read: %j", (page) => {
  expect(historyPageSchema.safeParse(page).success).toBe(false);
});

test("an empty or short page with a cursor continues even when has_more is false", () => {
  for (const messages of [[], [{}]]) {
    const page = historyPageSchema.parse({
      ok: true,
      messages,
      has_more: false,
      response_metadata: { next_cursor: "opaque==" },
    });
    expect(continueHistory(page, new Set())).toEqual({ kind: "more", cursor: "opaque==" });
  }
});

test("only exhausted cursors with no more records complete a pass", () => {
  for (const response_metadata of [undefined, null, {}, { next_cursor: "" }]) {
    expect(
      continueHistory(
        historyPageSchema.parse({
          ok: true,
          messages: [],
          response_metadata,
        }),
        new Set(),
      ),
    ).toEqual({ kind: "done" });
  }
});

test("a missing or repeated cursor is incomplete, not the end or an infinite loop", () => {
  expect(
    continueHistory(
      historyPageSchema.parse({
        ok: true,
        messages: [],
        has_more: true,
      }),
      new Set(),
    ),
  ).toEqual({ kind: "incomplete", reason: "missing_cursor" });
  expect(
    continueHistory(
      historyPageSchema.parse({
        ok: true,
        messages: [],
        has_more: true,
        response_metadata: { next_cursor: "again" },
      }),
      new Set(["again"]),
    ),
  ).toEqual({ kind: "incomplete", reason: "repeated_cursor" });
});

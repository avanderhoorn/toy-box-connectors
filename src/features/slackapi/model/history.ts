import { z } from "zod";

/** Leave each message intact for its owning decoder, including metadata and additive fields. */
export const historyPageSchema = z
  .object({
    ok: z.literal(true),
    messages: z.array(z.unknown()),
    has_more: z.boolean().nullish(),
    response_metadata: z.object({ next_cursor: z.string().nullish() }).nullish(),
  })
  .transform((page) => ({
    messages: page.messages,
    hasMore: page.has_more === true,
    nextCursor: page.response_metadata?.next_cursor || null,
  }));

export type HistoryPage = z.output<typeof historyPageSchema>;

/** An empty or short page is not the end while it supplies another cursor. */
export function continueHistory(
  page: HistoryPage,
  usedCursors: ReadonlySet<string>,
):
  | { kind: "more"; cursor: string }
  | { kind: "done" }
  | { kind: "incomplete"; reason: "missing_cursor" | "repeated_cursor" } {
  if (page.nextCursor !== null) {
    return usedCursors.has(page.nextCursor)
      ? { kind: "incomplete", reason: "repeated_cursor" }
      : { kind: "more", cursor: page.nextCursor };
  }
  return page.hasMore ? { kind: "incomplete", reason: "missing_cursor" } : { kind: "done" };
}

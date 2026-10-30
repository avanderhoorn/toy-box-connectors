import { z } from "zod";
import { renderMarkdown, type RenderedMessage, type RenderingProblem } from "./rendering";

const leadMessageSchema = z.strictObject({
  text: z.string().min(1).max(12_000),
  blocks: z
    .array(z.strictObject({ type: z.literal("markdown"), text: z.string().min(1).max(12_000) }))
    .length(1),
  mrkdwn: z.literal(false),
  parse: z.literal("none"),
  unfurl_links: z.literal(false),
  unfurl_media: z.literal(false),
});
export type LeadPayload =
  | { kind: "valid"; message: RenderedMessage; mentions: string[] }
  | { kind: "refused"; problem: RenderingProblem | "invalid_snapshot" };

// The line a post's block opens with, mentioning its people. Rendering escapes every <@ in the
// text below it, so a block opens with mentions only when the bridge put them there.
const mentionLine = /^(?:<@[UW][A-Z0-9]{2,20}> )*<@[UW][A-Z0-9]{2,20}>(?=\n\n)/;

/**
 * A snapshot is canonical when rendering its text again, with the people its block mentions,
 * changes nothing. Recheck secrets without changing the bytes the stored hash names.
 */
export function checkLeadPayload(payload: unknown): LeadPayload {
  const parsed = leadMessageSchema.safeParse(payload);
  if (!parsed.success) return { kind: "refused", problem: "invalid_snapshot" };
  const message = parsed.data;
  const line = mentionLine.exec(message.blocks[0]!.text)?.[0];
  const mentions = line ? line.replace(/[<@>]/g, "").split(" ") : [];
  const rendered = renderMarkdown(message.text, mentions);
  if (rendered.kind === "refused") return rendered;
  return rendered.message.text === message.text &&
    rendered.message.blocks[0]!.text === message.blocks[0]!.text
    ? { kind: "valid", message, mentions }
    : { kind: "refused", problem: "invalid_snapshot" };
}

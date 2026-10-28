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
  | { kind: "valid"; message: RenderedMessage }
  | { kind: "refused"; problem: RenderingProblem | "invalid_snapshot" };

/** Recheck canonical output and secrets without changing the bytes the stored hash names. */
export function checkLeadPayload(payload: unknown): LeadPayload {
  const parsed = leadMessageSchema.safeParse(payload);
  if (!parsed.success) return { kind: "refused", problem: "invalid_snapshot" };
  const message = parsed.data;
  if (message.blocks[0]!.text !== message.text)
    return { kind: "refused", problem: "invalid_snapshot" };
  const source = message.text
    .replace(/&lt;(?=[@!])/g, "<")
    .replace(/@\u200b(here|channel|everyone)\b/gi, "@$1");
  const rendered = renderMarkdown(source);
  if (rendered.kind === "refused") return rendered;
  return rendered.message.text === message.text
    ? { kind: "valid", message }
    : { kind: "refused", problem: "invalid_snapshot" };
}

import { z } from "zod";
import type { RenderedMessage } from "./rendering";
import { linkProblem, outputProblem, type OutputProblem } from "./safety";

const leadMessageSchema = z.strictObject({
  text: z.string().min(1).max(12_000),
  blocks: z
    .array(
      z.strictObject({
        type: z.literal("section"),
        text: z.strictObject({
          type: z.literal("mrkdwn"),
          text: z.string().min(1).max(3_000),
          verbatim: z.literal(true),
        }),
      }),
    )
    .min(1)
    .max(50),
  mrkdwn: z.literal(false),
  parse: z.literal("none"),
  unfurl_links: z.literal(false),
  unfurl_media: z.literal(false),
});

export type LeadPayload =
  | { kind: "valid"; message: RenderedMessage }
  | { kind: "refused"; problem: OutputProblem | "invalid_snapshot" | "message_too_long" };

/** Recheck the stored output without rendering it again or changing the bytes its hash names. */
export function checkLeadPayload(payload: unknown): LeadPayload {
  const parsed = leadMessageSchema.safeParse(payload);
  if (!parsed.success) return { kind: "refused", problem: "invalid_snapshot" };
  const message = parsed.data;
  if (/[<>]/.test(message.text)) return { kind: "refused", problem: "invalid_snapshot" };
  const sections = message.blocks.map((block) => block.text.text);
  if (sections.reduce((length, text) => length + text.length, 0) > 12_000) {
    return { kind: "refused", problem: "message_too_long" };
  }
  for (const text of [message.text, ...sections]) {
    const secret = outputProblem(text);
    if (secret) return { kind: "refused", problem: secret };
  }
  for (const section of sections) {
    for (const match of section.matchAll(/<([^>]*)>/g)) {
      const target = match[1]!.split("|", 1)[0]!;
      const problem = linkProblem(target);
      if (problem) return { kind: "refused", problem };
    }
  }
  return { kind: "valid", message };
}

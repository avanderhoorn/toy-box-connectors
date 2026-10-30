import { z } from "zod";
import { renderMarkdown, type RenderedMessage, type RenderingProblem } from "./rendering";
import { outputProblem } from "./safety";

/** The most images a post shows below its text. */
export const MAX_POST_IMAGES = 3;
/** The longest alt text Slack takes for an uploaded image. */
export const MAX_ALT_LENGTH = 1000;

/** An image a post shows, as its payload keeps it: what it shows, which also heads it in Slack. */
export type PostImage = { alt: string };
/** What a post says, as the outbox keeps it, with what each image it shows below the text shows. */
export type LeadPayload = RenderedMessage & { images?: PostImage[] };
/** An image block showing a file only the bot can see until a message shows it. */
type ImageBlock = {
  type: "image";
  slack_file: { id: string };
  alt_text: string;
  title: { type: "plain_text"; text: string };
};
/** What chat.postMessage sends for a payload: its text's block, then a block per image. */
export type LeadMessage = Omit<RenderedMessage, "blocks"> & {
  blocks: (RenderedMessage["blocks"][number] | ImageBlock)[];
};
export type PayloadCheck =
  | { kind: "valid"; message: LeadMessage; mentions: string[] }
  | { kind: "refused"; problem: RenderingProblem | "invalid_snapshot" };

const leadPayloadSchema = z.strictObject({
  text: z.string().min(1).max(12_000),
  blocks: z
    .array(z.strictObject({ type: z.literal("markdown"), text: z.string().min(1).max(12_000) }))
    .length(1),
  mrkdwn: z.literal(false),
  parse: z.literal("none"),
  unfurl_links: z.literal(false),
  unfurl_media: z.literal(false),
  images: z
    .array(z.strictObject({ alt: z.string().min(1).max(MAX_ALT_LENGTH) }))
    .min(1)
    .max(MAX_POST_IMAGES)
    .optional(),
});

// The line a post's block opens with, mentioning its people. Rendering escapes every <@ in the
// text below it, so a block opens with mentions only when the bridge put them there.
const mentionLine = /^(?:<@[UW][A-Z0-9]{2,20}> )*<@[UW][A-Z0-9]{2,20}>(?=\n\n)/;

/**
 * A snapshot is canonical when rendering its text again, with the people its block mentions,
 * changes nothing. Recheck secrets, in its images' alt text too, without changing the bytes the
 * stored hash names. `files` are the images' uploads, in order.
 */
export function checkLeadPayload(payload: unknown, files: readonly string[] = []): PayloadCheck {
  const parsed = leadPayloadSchema.safeParse(payload);
  if (!parsed.success) return { kind: "refused", problem: "invalid_snapshot" };
  const { images = [], ...message } = parsed.data;
  if (images.length !== files.length) return { kind: "refused", problem: "invalid_snapshot" };
  const line = mentionLine.exec(message.blocks[0]!.text)?.[0];
  const mentions = line ? line.replace(/[<@>]/g, "").split(" ") : [];
  const rendered = renderMarkdown(message.text, mentions);
  if (rendered.kind === "refused") return rendered;
  if (
    rendered.message.text !== message.text ||
    rendered.message.blocks[0]!.text !== message.blocks[0]!.text
  )
    return { kind: "refused", problem: "invalid_snapshot" };
  for (const { alt } of images) {
    const problem = outputProblem(alt);
    if (problem) return { kind: "refused", problem };
  }
  const shown = images.map(({ alt }, index) => imageBlock(files[index]!, alt));
  return {
    kind: "valid",
    message: { ...message, blocks: [...message.blocks, ...shown] },
    mentions,
  };
}

/** Slack heads an image block that has no title with only its size, so its alt text heads it. */
function imageBlock(fileId: string, alt: string): ImageBlock {
  return {
    type: "image",
    slack_file: { id: fileId },
    alt_text: alt,
    title: { type: "plain_text", text: alt },
  };
}

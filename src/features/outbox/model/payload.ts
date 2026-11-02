import { z } from "zod";
import { renderMarkdown, type RenderedMessage, type RenderResult } from "./rendering";
import { outputProblem, type OutputProblem } from "./safety";

/** The most images a post shows below its text. */
export const MAX_POST_IMAGES = 3;
/** The longest alt text Slack takes for an uploaded image. */
export const MAX_ALT_LENGTH = 1000;

/** An image a post shows, as its payload keeps it: what it shows, which also heads it in Slack. */
export type PostImage = { alt: string };
/**
 * What a post says, as the lead asked for it and the outbox keeps it until it's sent: its text,
 * the people it mentions and what each image it shows below the text shows.
 */
export type LeadPayload = { text: string; mentions: string[]; images: PostImage[] };
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
/** A payload's render, or why it can't go out, naming from 1 an image whose alt text can't. */
export type PayloadRender =
  | RenderResult
  | { kind: "refused"; problem: OutputProblem; image: number };
export type PayloadCheck =
  | { kind: "valid"; message: LeadMessage; mentions: string[] }
  | Extract<PayloadRender, { kind: "refused" }>
  | { kind: "refused"; problem: "invalid_payload" };

const leadPayloadSchema = z.strictObject({
  text: z.string(),
  mentions: z.array(z.string()),
  images: z
    .array(z.strictObject({ alt: z.string().min(1).max(MAX_ALT_LENGTH) }))
    .max(MAX_POST_IMAGES),
});

/**
 * Renders a payload's text with the people it mentions, and checks its images' alt text for
 * secrets as the text's are. Queueing renders it to refuse a post before it waits, and sending
 * renders it again, so what goes out passes the checks as they are when it goes.
 */
export function renderPayload({ text, mentions, images }: LeadPayload): PayloadRender {
  const rendered = renderMarkdown(text, mentions);
  if (rendered.kind === "refused") return rendered;
  for (const [index, { alt }] of images.entries()) {
    const problem = outputProblem(alt);
    if (problem) return { kind: "refused", problem, image: index + 1 };
  }
  return rendered;
}

/** Renders a stored payload to send it, showing its images' uploads, `files`, below its text. */
export function checkLeadPayload(payload: unknown, files: readonly string[] = []): PayloadCheck {
  const parsed = leadPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.images.length !== files.length)
    return { kind: "refused", problem: "invalid_payload" };
  const rendered = renderPayload(parsed.data);
  if (rendered.kind === "refused") return rendered;
  const shown = parsed.data.images.map(({ alt }, index) => imageBlock(files[index]!, alt));
  return {
    kind: "valid",
    message: { ...rendered.message, blocks: [...rendered.message.blocks, ...shown] },
    mentions: parsed.data.mentions,
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

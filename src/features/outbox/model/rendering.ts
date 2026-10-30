import { outputProblem, type OutputProblem } from "./safety";

export type RenderedMessage = {
  text: string;
  blocks: { type: "markdown"; text: string }[];
  mrkdwn: false;
  parse: "none";
  unfurl_links: false;
  unfurl_media: false;
};
export type RenderRefusal =
  | { kind: "refused"; problem: OutputProblem | "empty" }
  | { kind: "refused"; problem: "message_too_long"; limit: number; actual: number };
export type RenderingProblem = RenderRefusal["problem"];
export type RenderResult = { kind: "rendered"; message: RenderedMessage } | RenderRefusal;

/**
 * Slack translates standard Markdown. Only the bridge supplies the block and parsing flags, and the
 * only mentions that notify anyone are of the people a post names, which open its block on a line
 * of their own. The fallback text leaves them out, as Slack proved the block alone notifies.
 */
export function renderMarkdown(source: string, mentions: readonly string[] = []): RenderResult {
  const problem = outputProblem(source);
  if (problem) return { kind: "refused", problem };
  if (!source.trim()) return { kind: "refused", problem: "empty" };
  const text = source
    .replace(/@\u200b+/g, "@")
    .replace(/<(?=[@!])/g, "&lt;")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1");
  const line = [...new Set(mentions)].map((id) => `<@${id}>`).join(" ");
  const block = line ? `${line}\n\n${text}` : text;
  if (block.length > 12_000) {
    return { kind: "refused", problem: "message_too_long", actual: block.length, limit: 12_000 };
  }
  return {
    kind: "rendered",
    message: {
      text,
      blocks: [{ type: "markdown", text: block }],
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    },
  };
}

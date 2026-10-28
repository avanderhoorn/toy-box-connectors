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

/** Slack translates standard Markdown. Only the bridge supplies the block and parsing flags. */
export function renderMarkdown(source: string): RenderResult {
  const problem = outputProblem(source);
  if (problem) return { kind: "refused", problem };
  if (!source.trim()) return { kind: "refused", problem: "empty" };
  const text = source
    .replace(/@\u200b/g, "@")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1");
  if (text.length > 12_000) {
    return { kind: "refused", problem: "message_too_long", actual: text.length, limit: 12_000 };
  }
  return {
    kind: "rendered",
    message: {
      text,
      blocks: [{ type: "markdown", text }],
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    },
  };
}

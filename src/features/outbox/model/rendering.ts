import { Marked, type MarkedToken, type Token } from "marked";
import { linkProblem, outputProblem, type OutputProblem } from "./safety";

export type MessageSection = {
  type: "section";
  text: { type: "mrkdwn"; text: string; verbatim: true };
};

/** Only this renderer, never the caller, supplies Slack formatting and controls. */
export type RenderedMessage = {
  text: string;
  blocks: MessageSection[];
  mrkdwn: false;
  parse: "none";
  unfurl_links: false;
  unfurl_media: false;
};

export type RenderRefusal =
  | { kind: "refused"; problem: OutputProblem | "empty" }
  | {
      kind: "refused";
      problem: "message_too_long";
      limit: number;
      actual: number;
      surface: "fallback" | "sections";
    }
  | { kind: "refused"; problem: "too_many_blocks"; limit: number; actual: number }
  | {
      kind: "refused";
      problem: "section_too_long";
      limit: number;
      actual: number;
      line: number;
      preview: string;
    };

export type RenderingProblem = RenderRefusal["problem"];

export type RenderResult = { kind: "rendered"; message: RenderedMessage } | RenderRefusal;

type Style = "bold" | "italic" | "strike" | "code" | "pre";
type Run = {
  text: string;
  styles: readonly Style[];
  quote: number;
  indent: number;
  href?: string;
};
type Context = Pick<Run, "styles" | "quote" | "indent">;

const sectionLimit = 3_000;
const messageLimit = 12_000;
const blockLimit = 50;
const markdown = new Marked({ gfm: true, breaks: false });
const markers: Record<Style, { open: string; close: string }> = {
  bold: { open: "*", close: "*" },
  italic: { open: "_", close: "_" },
  strike: { open: "~", close: "~" },
  code: { open: "`", close: "`" },
  pre: { open: "```\n", close: "\n```" },
};

/** Render once before queuing. Refusals contain categories, never matched text. */
export function renderMarkdown(source: string): RenderResult {
  const problem = outputProblem(source);
  if (problem) return { kind: "refused", problem };
  try {
    const groups = markdown
      .lexer(source)
      .map((token) => tokenRuns(token, { styles: [], quote: 0, indent: 0 }))
      .filter((runs) => runs.length > 0);
    const plain = groups.map(plainRuns).join("\n\n");
    const text = escapeText(neutralize(plain));
    if (!plain.trim()) return { kind: "refused", problem: "empty" };
    const renderedProblem = outputProblem(plain);
    if (renderedProblem) return { kind: "refused", problem: renderedProblem };
    const sections: string[] = [];
    let firstLine = 1;
    for (const runs of groups) {
      for (const chunk of chunkRuns(runs, firstLine)) {
        const previous = sections.at(-1);
        if (previous !== undefined && previous.length + 2 + chunk.length <= sectionLimit) {
          sections[sections.length - 1] = previous + "\n\n" + chunk;
        } else {
          sections.push(chunk);
        }
      }
      firstLine += plainRuns(runs).split("\n").length + 1;
    }
    if (sections.length > blockLimit) {
      return {
        kind: "refused",
        problem: "too_many_blocks",
        limit: blockLimit,
        actual: sections.length,
      };
    }
    const sectionLength = sections.reduce((length, section) => length + section.length, 0);
    if (text.length > messageLimit || sectionLength > messageLimit) {
      const surface = text.length > messageLimit ? "fallback" : "sections";
      return {
        kind: "refused",
        problem: "message_too_long",
        limit: messageLimit,
        actual: surface === "fallback" ? text.length : sectionLength,
        surface,
      };
    }
    return {
      kind: "rendered",
      message: {
        text,
        blocks: sections.map((section) => ({
          type: "section",
          text: { type: "mrkdwn", text: section, verbatim: true },
        })),
        mrkdwn: false,
        parse: "none",
        unfurl_links: false,
        unfurl_media: false,
      },
    };
  } catch (error) {
    if (error instanceof RenderingRefused) return error.refusal;
    throw error;
  }
}

export function describeRenderingRefusal(refusal: RenderRefusal): string {
  switch (refusal.problem) {
    case "empty":
      return "The message is empty after rendering. Add text before posting.";
    case "section_too_long":
      return (
        `Rendered line ${refusal.line} (${JSON.stringify(refusal.preview)}) needs ` +
        `${refusal.actual} characters, limit ${refusal.limit} per section. ` +
        "Break it into shorter lines."
      );
    case "message_too_long":
      return (
        `The ${refusal.surface === "fallback" ? "plain fallback" : "rendered sections"} ` +
        `contains ${refusal.actual} characters, limit ${refusal.limit}. Shorten the message.`
      );
    case "too_many_blocks":
      return (
        `The message needs ${refusal.actual} blocks, limit ${refusal.limit}. ` +
        "Reduce the number of paragraphs."
      );
    case "private_link":
      return (
        "The message makes a local or private-network URL clickable. " +
        "Remove that link, or show it as code."
      );
    case "unsafe_link":
      return "Only public HTTP(S) links without credentials are allowed. Replace or remove the link.";
    default:
      return `The message may contain a secret (${refusal.problem}). Remove it before posting.`;
  }
}

class RenderingRefused extends Error {
  constructor(readonly refusal: RenderRefusal) {
    super(refusal.problem);
  }
}

function tokenRuns(token: Token, context: Context): Run[] {
  // This lexer has no extensions. Reject an unexpected kind instead of guessing at its fields.
  if (!builtinToken(token)) throw new Error("The Markdown parser returned an unsupported token");
  const run = (text: string): Run => ({ text, ...context });
  const inline = (tokens: readonly Token[]): Run[] =>
    tokens.flatMap((child) => tokenRuns(child, context));
  const styled = (style: Style, tokens: readonly Token[]): Run[] =>
    tokens.flatMap((child) =>
      tokenRuns(child, {
        ...context,
        styles: context.styles.includes(style) ? context.styles : [...context.styles, style],
      }),
    );
  switch (token.type) {
    case "space":
    case "def":
      return [];
    case "paragraph":
      return inline(token.tokens);
    case "list_item":
      return joinBlocks(token.tokens, context);
    case "text":
      return token.tokens ? inline(token.tokens) : [run(token.text)];
    case "escape":
    case "html":
      return [run(token.text)];
    case "strong":
    case "heading":
      return styled("bold", token.tokens);
    case "em":
      return styled("italic", token.tokens);
    case "del":
      return styled("strike", token.tokens);
    case "codespan":
    case "code": {
      const style = token.type === "code" || token.text.includes("`") ? "pre" : "code";
      return [{ ...run(token.text), styles: [...context.styles, style] }];
    }
    case "blockquote":
      return joinBlocks(token.tokens, { ...context, quote: context.quote + 1 });
    case "br":
      return [run("\n")];
    case "hr":
      return [run("---")];
    case "checkbox":
      return [run(token.checked ? "[x] " : "[ ] ")];
    case "list": {
      const runs: Run[] = [];
      for (const [index, item] of token.items.entries()) {
        if (index) runs.push(run("\n"));
        const bullet = token.ordered ? `${Number(token.start) + index}. ` : "- ";
        runs.push(run(bullet));
        runs.push(...joinBlocks(item.tokens, { ...context, indent: context.indent + 1 }));
      }
      return runs;
    }
    case "link":
    case "image": {
      const label =
        inline(token.tokens)
          .map(plainRun)
          .join("")
          .replace(/\s*\n\s*/g, " ") || token.href;
      const protocol = URL.canParse(token.href) ? new URL(token.href).protocol : null;
      const explicit = token.raw.startsWith("[") || token.raw.startsWith("![");
      if (protocol === "mailto:") {
        const address = token.href.slice("mailto:".length);
        return [run(label === address || label === token.href ? address : `${label} (${address})`)];
      }
      if (!explicit && protocol !== "http:" && protocol !== "https:") return [run(label)];
      const problem = linkProblem(token.href);
      if (problem) throw new RenderingRefused({ kind: "refused", problem });
      return [{ ...run(label), href: new URL(token.href).href }];
    }
    case "table": {
      const rows = [token.header, ...token.rows];
      return rows.flatMap((cells, row) => {
        const runs: Run[] = row ? [run("\n")] : [];
        for (const [column, cell] of cells.entries()) {
          if (column) runs.push(run(" | "));
          runs.push(...(row ? inline(cell.tokens) : styled("bold", cell.tokens)));
        }
        return runs;
      });
    }
  }
}

function joinBlocks(tokens: readonly Token[], context: Context): Run[] {
  const result: Run[] = [];
  let separator = "";
  for (const token of tokens) {
    if (token.type === "space") {
      separator = "\n\n";
      continue;
    }
    const runs = tokenRuns(token, context);
    if (!runs.length) continue;
    if (result.length && separator) result.push({ text: separator, ...context });
    result.push(...runs);
    separator = token.type === "checkbox" ? "" : token.type === "text" ? "\n" : "\n\n";
  }
  return result;
}

function plainRuns(runs: readonly Run[]): string {
  let text = "";
  let lineStart = true;
  for (const run of runs) {
    for (const point of plainRun(run)) {
      if (lineStart) text += linePrefix(run);
      text += point;
      lineStart = point === "\n";
    }
  }
  return text;
}

function plainRun(run: Run): string {
  return run.href && run.text !== run.href ? `${run.text} (${run.href})` : run.text;
}

function linePrefix(run: Run): string {
  return "> ".repeat(run.quote) + "  ".repeat(run.indent);
}

/** Break only between lines, closing and reopening formatting around each section. */
function chunkRuns(runs: readonly Run[], firstLine: number): string[] {
  const sections: string[] = [];
  let text = "";
  let styles: readonly Style[] = [];
  let hasLine = false;
  const finish = (): void => {
    if (text) sections.push(text + closeStyles(styles));
    text = "";
    styles = [];
    hasLine = false;
  };
  for (const [index, line] of linesOf(runs).entries()) {
    let next = renderLine(line, styles);
    if (
      text.length + (hasLine ? 1 : 0) + next.text.length + closeStyles(next.styles).length >
      sectionLimit
    ) {
      finish();
      next = renderLine(line, styles);
    }
    if (next.text.length + closeStyles(next.styles).length > sectionLimit) {
      const words = line.map(plainRun).join("").trim().split(/\s+/).slice(0, 6).join(" ");
      throw new RenderingRefused({
        kind: "refused",
        problem: "section_too_long",
        limit: sectionLimit,
        actual: next.text.length + closeStyles(next.styles).length,
        line: firstLine + index,
        preview: Array.from(words).slice(0, 80).join(""),
      });
    }
    text += (hasLine ? "\n" : "") + next.text;
    styles = next.styles;
    hasLine = true;
  }
  finish();
  return sections;
}

function linesOf(runs: readonly Run[]): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  for (const run of runs) {
    if (run.href) {
      line.push(run);
      continue;
    }
    for (const [index, part] of run.text.split("\n").entries()) {
      if (index) {
        lines.push(line);
        line = [];
      }
      line.push({ ...run, text: part });
    }
  }
  lines.push(line);
  return lines;
}

function renderLine(
  runs: readonly Run[],
  initial: readonly Style[],
): { text: string; styles: readonly Style[] } {
  let text = "";
  let styles = initial;
  for (const [index, run] of runs.entries()) {
    if (!index) text += linePrefix(run);
    text += transition(styles, run.styles);
    const content = neutralize(run.text);
    if (run.href) {
      const target = escapeText(run.href.replace(/\|/g, "%7C"));
      text += `<${target}|${escapeText(content)}>`;
    } else {
      const literal = run.styles.includes("pre") ? content.replace(/`(?=``)/g, "`\u200b") : content;
      text += escapeText(literal);
    }
    styles = run.styles;
  }
  return { text, styles };
}

function transition(before: readonly Style[], after: readonly Style[]): string {
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) {
    shared++;
  }
  return (
    closeStyles(before.slice(shared)) +
    after
      .slice(shared)
      .map((style) => markers[style].open)
      .join("")
  );
}

function closeStyles(styles: readonly Style[]): string {
  return styles
    .toReversed()
    .map((style) => markers[style].close)
    .join("");
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function neutralize(text: string): string {
  return text.replaceAll("@\u200b", "@").replace(/@(here|channel|everyone)\b/gi, "@\u200b$1");
}

const builtinTypes = new Set([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);

function builtinToken(token: Token): token is MarkedToken {
  return builtinTypes.has(token.type);
}

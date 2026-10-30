// A file's text, as the lead reads it.
//
// A file isn't Slack markup, so its text needs none of the unescaping a message's does. It must be
// UTF-8 without a NUL, which no text file holds. Tabs and line breaks stay, with CRLF as LF, and
// every other control character, DEL and C1 included, shows as U+FFFD, so a file can't send escape
// sequences to the lead's shell and a colored CI log still reads.
//
// The lead reads a file a page at a time. A page counts code points rather than what they draw,
// since one character can carry thousands of combining marks, so even a page of four-byte code
// points stays well under the 200 KB at which Copilot saves a command's output to a file of its
// own.

/** A file's text, or why it isn't text. A reason follows "can't be read since". */
export type FileText = { kind: "text"; text: string } | { kind: "refused"; reason: string };
/** One page of a file's text, and how many pages it has. */
export type TextPage = { text: string; page: number; pages: number };

/** Code points per page. */
export const pageLength = 30_000;

const controls = /[^\P{Cc}\n\t]/gu;
const notText: FileText = { kind: "refused", reason: "it isn't UTF-8 text" };

/** `bytes` as text the lead can read, or why they aren't text. */
export function readText(bytes: Uint8Array): FileText {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return notText;
  }
  if (text.includes("\0")) return notText;
  return { kind: "text", text: text.replaceAll("\r\n", "\n").replace(controls, "\uFFFD") };
}

/** Page `page` of `text`, counting from 1, or null when there's no such page. */
export function textPage(text: string, page: number): TextPage | null {
  const points = Array.from(text);
  const pages = Math.max(1, Math.ceil(points.length / pageLength));
  if (page < 1 || page > pages) return null;
  const start = (page - 1) * pageLength;
  return { text: points.slice(start, start + pageLength).join(""), page, pages };
}

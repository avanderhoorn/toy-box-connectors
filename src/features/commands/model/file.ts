// Shared files as the lead reads them: listed under the messages that share them, and read with
// file.
//
// A listing line starts with the bridge's own words and ends with the file's name in quotes, which
// the name can't close, so nothing the bridge adds follows text someone else chose. A line names a
// file's type in the bridge's own words, never Slack's or its uploader's. A file's text is data
// like a message's: it's fenced under a label naming who shared it, and nothing in it mentions
// anyone in Toy Box, since the lead may quote it.

import type { Image } from "@files/model/images";
import type { FileFormat, FileVerdict } from "@files/model/readable";
import { textPage, type TextPage } from "@files/model/text";
import type { SlackFile } from "@slackapi/model/files";
import type { SlackPerson } from "./inbox";
import { fenceFor, fileName, neutralizeMentions } from "./slackText";
import { count } from "./wording";

/** A file as inbox and activity list it, with the reference to read it by or why it can't be. */
export type ListedFile =
  | {
      reference: string;
      /** How it reads, or null until file asks Slack. */
      format: FileFormat | null;
      size: number | null;
      name: string | null;
    }
  | { reason: string; size: number | null; name: string | null };

/** What file answers: a page of a file's text, or where to view the image. */
export type FileAnswer = {
  file: string;
  name: string | null;
  sharer: SlackPerson<string | null>;
  uploader: SlackPerson;
} & (({ format: "text" } & TextPage) | (Image & { path: string }));

const formatNames: Record<FileFormat, string> = { text: "text", png: "PNG", jpeg: "JPEG" };

/** File `id`, as inbox and activity list it once `verdict` says whether the lead may read it. */
export function listFile(id: number, file: SlackFile, verdict: FileVerdict): ListedFile {
  const size = file.whole ? file.size : null;
  const name = file.whole ? fileName(file.name) : null;
  if (verdict.kind === "refused") return { reason: verdict.reason, size, name };
  const format = verdict.kind === "readable" ? verdict.format : null;
  return { reference: `f${id}`, format, size, name };
}

/** A listed file as a Markdown list item. */
export function presentListedFile(file: ListedFile): string {
  const size = file.size === null ? [] : [fileSize(file.size)];
  const words =
    "reference" in file
      ? [
          file.reference,
          ...(file.format === null ? [] : [formatNames[file.format]]),
          ...size,
          `read it with \`toy-box-slack file ${file.reference}\``,
        ]
      : [...size, `can't be read since ${file.reason}`];
  return `- ${words.join(", ")}${quoted(file.name)}`;
}

/** Page `page` of a file's text, or null when it has no such page. */
export function fileTextPage(text: string, page: number): TextPage | null {
  return textPage(neutralizeMentions(text), page);
}

/** What file answers, as Markdown. */
export function presentFileAnswer(answer: FileAnswer): string {
  const { file, sharer, uploader } = answer;
  const uploaded = uploader.userId === sharer.userId ? "" : `, uploaded by ${uploader.name}`;
  const from = `from ${sharer.name}${uploaded}${quoted(answer.name)}`;
  if (answer.format !== "text") {
    const image = `${answer.width}×${answer.height} ${formatNames[answer.format]}`;
    return `${file} is a ${image} ${from}\nView it now at ${answer.path}, since the bridge soon deletes it.`;
  }
  const { text, page, pages } = answer;
  if (pages === 1 && text.trim() === "") return `${file} is a blank text file ${from}`;
  const fence = fenceFor(text);
  const shown = `${fence}file ${file} ${from}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
  if (pages === 1) return shown;
  if (page === pages) return `${shown}\nPage ${page} of ${pages}, the last.`;
  const next = `toy-box-slack file ${file} --page ${page + 1}`;
  return `${shown}\nPage ${page} of ${pages}. Run \`${next}\` for the next.`;
}

function quoted(name: string | null): string {
  return name === null ? "" : `: "${name}"`;
}

// In KB and MB of 1,024 bytes, as the bridge's limits on what it reads are.
function fileSize(bytes: number): string {
  if (bytes < 1024) return count(bytes, "byte");
  const kilobytes = Math.round(bytes / 1024);
  if (kilobytes < 1024) return `${kilobytes} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

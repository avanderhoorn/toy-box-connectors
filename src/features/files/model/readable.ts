// Which shared files the lead may read.
//
// One rule decides for inbox, activity and file, so the inbox offers only files the lead can read,
// and file reads only what the inbox would offer. A file reads only while whoever shared it and
// whoever uploaded it are both on the allowlist, since a message can share someone else's file.
// The bridge reads files Slack hosts, as uploads or snippets: text other than HTML of up to 1 MiB,
// and the PNG and JPEG images screenshots come as, up to the 10 MiB the lead's viewer opens. A
// message that describes a file only by its ID leaves the rest to files.info, which file asks.

import { MIMEType } from "node:util";
import type { SlackFile } from "@slackapi/model/files";
import type { ImageFormat } from "./images";

/** How the bridge reads a file: as text, or as the image its type names. */
export type FileFormat = "text" | ImageFormat;
/** Whether the lead may read a file. A reason follows "can't be read since". */
export type FileVerdict =
  | { kind: "readable"; format: FileFormat }
  /** Only files.info can say, since the message gave just the file's ID. */
  | { kind: "unsettled" }
  | { kind: "refused"; reason: string };

const textCap = 1024 ** 2;
const imageCap = 10 * 1024 ** 2;
const textTypes: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

/**
 * Whether the lead may read `file`, which `sharerId` shared. `allowed` says whether someone is on
 * the allowlist now, by any of their Slack IDs.
 */
export function judgeFile(
  file: SlackFile,
  sharerId: string,
  allowed: (userId: string) => boolean,
): FileVerdict {
  if (!allowed(sharerId)) return refused("whoever shared it isn't on the allowlist");
  if (!file.whole) return { kind: "unsettled" };
  if (!allowed(file.uploaderId)) return refused("whoever uploaded it isn't on the allowlist");
  if (file.mode === "external") return refused("it's stored outside Slack");
  const type = essence(file.mimeType);
  if (type === "text/html") return refused("the bridge doesn't read HTML");
  const format = file.mode === "hosted" || file.mode === "snippet" ? formatOf(type) : null;
  if (!format) return refused("the bridge reads only text, PNG and JPEG");
  if (format === "text" && file.size > textCap)
    return refused("it's over 1 MiB, more text than the bridge reads");
  if (format !== "text" && file.size > imageCap)
    return refused("it's over 10 MiB, more than you can view, so ask for a crop or a JPEG");
  return { kind: "readable", format };
}

/** A MIME type without its parameters, in lowercase, or null when it isn't one. */
function essence(mimeType: string): string | null {
  try {
    return new MIMEType(mimeType).essence;
  } catch {
    return null;
  }
}

function formatOf(type: string | null): FileFormat | null {
  if (type === null) return null;
  if (type.startsWith("text/") || textTypes.has(type)) return "text";
  if (type === "image/png") return "png";
  if (type === "image/jpeg") return "jpeg";
  return null;
}

function refused(reason: string): FileVerdict {
  return { kind: "refused", reason };
}

import { z } from "zod";
import type { SlackCall } from "../server/botClient";
import { compareTs, slackTsSchema, type SlackTs } from "./ts";

// Files as the messages that share them describe them, and as files.info does.
//
// A message's description can be stale, and Slack Connect sends only the file's ID, with
// file_access check_file_info, so the bridge reads a file only on files.info's fresh facts. Slack
// lists where a file is shared by channel, public channels apart from private ones, with the ts of
// each message that shares it, so a file reads only while the message that listed it still shares
// it. Slack doesn't hold an external file's bytes, and its URL is whatever its uploader chose, so
// the bridge never fetches one.

/** A file a message shares, as the message describes it. A partial one has only its ID. */
export type SlackFile = WholeFile | { id: string; whole: false };
type WholeFile = {
  id: string;
  whole: true;
  name: string | null;
  mimeType: string;
  mode: string;
  size: number;
  uploaderId: string;
};
/** A file as files.info describes it, still shared where the bridge found it. */
export type FileFacts = WholeFile & {
  /** Where Slack serves the file's bytes to the bot's token. */
  url: string;
};
/** Whether files.info's answer lets the bridge read a file. A reason follows "can't be read since". */
export type FileInfoVerdict =
  | { kind: "file"; file: FileFacts }
  | { kind: "refused"; reason: string };

const id = z.string().min(1);
const fileMarksSchema = z.object({
  id: id.describe("File ID"),
  mode: z.unknown().optional().describe("How Slack holds the file, tombstone once deleted"),
  is_deleted: z.unknown().optional(),
  is_tombstoned: z.unknown().optional(),
  file_access: z.unknown().optional().describe("check_file_info when only files.info describes it"),
});
const wholeFileSchema = z.object({
  id: id.describe("File ID"),
  name: z.string().nullish().describe("File name, chosen by whoever uploaded it"),
  mimetype: z.string().min(1).describe("MIME type"),
  mode: z.string().min(1).describe("How Slack holds the file"),
  size: z.number().int().nonnegative().describe("Bytes"),
  user: id.describe("Uploader"),
});
const sharesSchema = z
  .record(id, z.array(z.object({ ts: slackTsSchema.describe("A message that shares the file") })))
  .describe("The messages that share the file, by channel");
const fileInfoSchema = z.object({
  file: wholeFileSchema.extend({
    is_deleted: z.unknown().optional(),
    is_tombstoned: z.unknown().optional(),
    is_hidden_by_limit: z.unknown().optional().describe("Hidden by a free workspace's limit"),
    is_external: z
      .boolean()
      .nullish()
      .describe("Stored outside Slack, at a URL its uploader chose"),
    url_private: z.string().nullish().describe("Its bytes, to a token with files:read"),
    url_private_download: z.string().nullish().describe("Its bytes as a download"),
    shares: z
      .object({ public: sharesSchema.nullish(), private: sharesSchema.nullish() })
      .nullish()
      .describe("Where it's shared, among the channels the bot can read"),
    has_more_shares: z.unknown().optional().describe("True when shares lists only some of them"),
  }),
});

/** The files a message shares, once each. One odd file never costs the message the others. */
export function sharedFiles(values: readonly unknown[]): SlackFile[] {
  const files = new Map<string, SlackFile>();
  for (const value of values) {
    const file = readSharedFile(value);
    if (file && !files.has(file.id)) files.set(file.id, file);
  }
  return [...files.values()];
}

/** What files.info's answer says about reading the file that `share`, a message's channel and ts, lists. */
export function judgeFileInfo(
  call: SlackCall<unknown>,
  share: { channelId: string; ts: SlackTs },
): FileInfoVerdict {
  switch (call.kind) {
    case "rate_limited":
      return refused("Slack asked the bridge to wait, so try again shortly");
    case "auth_failed":
      return refused("Slack rejects the bridge's tokens");
    case "unknown":
      return refused("Slack didn't answer, so try again shortly");
    case "error":
      return refused(errorReason(call.error));
    case "ok":
      break;
  }
  const parsed = fileInfoSchema.safeParse(call.result);
  if (!parsed.success) return refused("Slack's description of it couldn't be read");
  const { file } = parsed.data;
  if (isDeleted(file)) return refused("Slack no longer has it");
  if (file.is_hidden_by_limit) return refused("the workspace's Slack plan hides it");
  if (file.is_external) return refused("it's stored outside Slack");
  const messages = [
    file.shares?.public?.[share.channelId],
    file.shares?.private?.[share.channelId],
  ];
  if (!messages.some((listed) => listed?.some(({ ts }) => compareTs(ts, share.ts) === 0)))
    return refused(
      file.has_more_shares === true
        ? "it's shared in too many places for Slack to confirm its message still shares it"
        : "its message no longer shares it",
    );
  const url = file.url_private_download ?? file.url_private;
  if (!url) return refused("Slack gave no address for it");
  return { kind: "file", file: { ...describe(file), url } };
}

/** A shared file, or null for a deleted one or anything without an ID. */
function readSharedFile(value: unknown): SlackFile | null {
  const marks = fileMarksSchema.safeParse(value);
  if (!marks.success || isDeleted(marks.data)) return null;
  const file = wholeFileSchema.safeParse(value);
  if (marks.data.file_access === "check_file_info" || !file.success)
    return { id: marks.data.id, whole: false };
  return describe(file.data);
}

/** Slack marks a deleted file any of these ways, and a message no longer shares one. */
function isDeleted(file: { mode?: unknown; is_deleted?: unknown; is_tombstoned?: unknown }) {
  return file.mode === "tombstone" || file.is_deleted === true || file.is_tombstoned === true;
}

function describe(file: z.output<typeof wholeFileSchema>): WholeFile {
  return {
    id: file.id,
    whole: true,
    name: file.name ?? null,
    mimeType: file.mimetype,
    mode: file.mode,
    size: file.size,
    uploaderId: file.user,
  };
}

function errorReason(code: string): string {
  switch (code) {
    case "file_not_found":
    case "file_deleted":
      return "Slack no longer has it";
    case "missing_scope":
      return "the Slack app doesn't have the files:read scope yet. Ask the owner to add it on the app's OAuth & Permissions page and reinstall the app to the workspace";
    default:
      return `Slack refused with ${code}`;
  }
}

function refused(reason: string): FileInfoVerdict {
  return { kind: "refused", reason };
}

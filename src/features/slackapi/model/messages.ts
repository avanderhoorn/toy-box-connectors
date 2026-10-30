import { z } from "zod";
import type { Installation } from "./installation";
import { compareTs, slackTsSchema, type SlackTs } from "./ts";

const id = z.string().min(1);
export const slackMessageSchema = z.object({
  type: z.literal("message").optional().describe("Message object"),
  subtype: z.string().nullish().describe("Message subtype"),
  ts: slackTsSchema.describe("Message ID"),
  thread_ts: slackTsSchema.nullish().describe("Root ID, including on roots themselves"),
  user: id.nullish().describe("Author"),
  bot_id: id.nullish().describe("Bot author"),
  app_id: id.nullish().describe("App author"),
  text: z.string().nullish().describe("Slack text"),
  edited: z.object({ ts: slackTsSchema.describe("Edit time") }).nullish(),
  latest_reply: slackTsSchema.nullish().describe("A root's newest reply"),
  hidden: z.boolean().nullish().describe("Content withdrawn"),
  files: z.array(z.unknown()).nullish().describe("Shared files, each read on its own"),
});
// A message describes each file it shares. Slack Connect sends only the file's ID with file_access
// check_file_info, so only files.info can say what such a file is.
const fileMarksSchema = z.object({
  id: id.describe("File ID"),
  mode: z.unknown().optional().describe("How Slack holds the file, tombstone once deleted"),
  is_deleted: z.unknown().optional(),
  is_tombstoned: z.unknown().optional(),
  file_access: z.unknown().optional().describe("check_file_info when only files.info describes it"),
});
const wholeFileSchema = z.object({
  name: z.string().nullish().describe("File name, chosen by whoever uploaded it"),
  mimetype: z.string().min(1).describe("MIME type"),
  mode: z.string().min(1).describe("How Slack holds the file"),
  size: z.number().int().nonnegative().describe("Bytes"),
  user: id.describe("Uploader"),
});
const bookkeeping = new Set(["message_changed", "message_deleted", "message_replied"]);
export const slackMessageEventSchema = z.union([
  z
    .object({
      type: z.literal("message"),
      subtype: z.enum(["message_changed", "message_replied"]),
      channel: id,
      message: slackMessageSchema,
    })
    .transform(({ channel, message, subtype }) => ({
      shape: subtype === "message_changed" ? ("changed" as const) : ("replied" as const),
      channel,
      message,
    })),
  z
    .object({
      type: z.literal("message"),
      subtype: z.literal("message_deleted"),
      channel: id,
      deleted_ts: slackTsSchema,
    })
    .transform(({ channel, deleted_ts }) => ({
      shape: "deleted" as const,
      channel,
      deletedTs: deleted_ts,
    })),
  slackMessageSchema
    .extend({
      type: z.literal("message"),
      channel: id,
      subtype: z
        .string()
        .refine((value) => !bookkeeping.has(value))
        .nullish(),
    })
    .transform(({ channel, ...message }) => ({ shape: "posted" as const, channel, message })),
]);
export type SlackMessagePayload = z.output<typeof slackMessageSchema>;
export type SlackMessageEventPayload = z.output<typeof slackMessageEventSchema>;
export type MessageAuthor = "person" | "self" | "bot" | "notice";
export type SlackMessage = {
  channelId: string;
  ts: SlackTs;
  threadTs: SlackTs | null;
  rootTs: SlackTs;
  isReply: boolean;
  userId: string | null;
  author: MessageAuthor;
  text: string;
  mentions: string[];
  mentionsBot: boolean;
  editedTs: SlackTs | null;
  version: SlackTs;
  files: SlackFile[];
};
/** A file a message shares, as the message describes it. A partial one has only its ID. */
export type SlackFile =
  | {
      id: string;
      whole: true;
      name: string | null;
      mimeType: string;
      mode: string;
      size: number;
      uploaderId: string;
    }
  | { id: string; whole: false };
export type SlackMessageEvent =
  | { kind: "message"; message: SlackMessage }
  | { kind: "deleted"; channelId: string; ts: SlackTs }
  | { kind: "replied" };
type NormalizeContext = Pick<Installation, "botUserId" | "botId">;

export function normalizeMessageEvent(
  event: SlackMessageEventPayload,
  context: NormalizeContext,
): SlackMessageEvent {
  if (event.shape === "deleted")
    return { kind: "deleted", channelId: event.channel, ts: event.deletedTs };
  if (event.shape === "replied") return { kind: "replied" };
  return normalizeHistoryMessage(event.channel, event.message, context);
}

export function normalizeHistoryMessage(
  channelId: string,
  payload: SlackMessagePayload,
  context: NormalizeContext,
): SlackMessageEvent {
  // A deleted root with replies is a hidden tombstone, not an ordinary edit.
  if (payload.subtype === "tombstone" || isWithdrawn(payload))
    return { kind: "deleted", channelId, ts: payload.ts };
  const threadTs = payload.thread_ts ?? null;
  const isReply = threadTs !== null && compareTs(threadTs, payload.ts) !== 0;
  const text = payload.text ?? "";
  const mentions = [
    ...new Set(Array.from(text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g), (match) => match[1]!)),
  ].sort();
  return {
    kind: "message",
    message: {
      channelId,
      ts: payload.ts,
      threadTs,
      rootTs: isReply ? threadTs : payload.ts,
      isReply,
      userId: payload.user ?? null,
      author: messageAuthor(payload, context),
      text,
      mentions,
      mentionsBot: mentions.includes(context.botUserId),
      editedTs: payload.edited?.ts ?? null,
      version: payload.edited?.ts ?? payload.ts,
      files: sharedFiles(payload.files ?? []),
    },
  };
}

/** The files a message shares, once each. One odd file never costs the message the others. */
function sharedFiles(values: readonly unknown[]): SlackFile[] {
  const files = new Map<string, SlackFile>();
  for (const value of values) {
    const file = readSharedFile(value);
    if (file && !files.has(file.id)) files.set(file.id, file);
  }
  return [...files.values()];
}

/** A shared file, or null for a deleted one or anything without an ID. */
function readSharedFile(value: unknown): SlackFile | null {
  const marks = fileMarksSchema.safeParse(value);
  if (!marks.success) return null;
  const { id, mode, is_deleted, is_tombstoned, file_access } = marks.data;
  // Slack marks a deleted file any of these ways, and a message no longer shares one.
  if (mode === "tombstone" || is_deleted === true || is_tombstoned === true) return null;
  const file = wholeFileSchema.safeParse(value);
  if (file_access === "check_file_info" || !file.success) return { id, whole: false };
  return {
    id,
    whole: true,
    name: file.data.name ?? null,
    mimeType: file.data.mimetype,
    mode: file.data.mode,
    size: file.data.size,
    uploaderId: file.data.user,
  };
}

export function isWithdrawn(payload: SlackMessagePayload): boolean {
  return (
    payload.subtype === "ekm_access_denied" ||
    payload.hidden === true ||
    payload.user === "UREVOKEDU"
  );
}

function messageAuthor(payload: SlackMessagePayload, context: NormalizeContext): MessageAuthor {
  const subtype = payload.subtype ?? null;
  if (subtype && !["bot_message", "file_share", "me_message", "thread_broadcast"].includes(subtype))
    return "notice";
  if (payload.user === context.botUserId || payload.bot_id === context.botId) return "self";
  if (payload.bot_id || payload.app_id || subtype === "bot_message") return "bot";
  if (!payload.user) return "notice";
  return payload.user === "USLACKBOT" ? "bot" : "person";
}

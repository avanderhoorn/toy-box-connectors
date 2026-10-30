import { z } from "zod";
import { sharedFiles, type SlackFile } from "./files";
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

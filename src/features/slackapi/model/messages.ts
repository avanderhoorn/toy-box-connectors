import { z } from "zod";
import { slackTsSchema, type SlackTs } from "./ts";

// Slack messages as the Events API and history methods carry them, and the one
// canonical shape the ledger stores. Slack adds fields without notice, so these
// schemas drop unknown keys instead of refusing them, and optional fields accept
// the nulls Slack sometimes sends in their place.

const slackIdSchema = z.string().min(1);

const slackFileSchema = z
  .object({
    id: slackIdSchema.describe("The file's ID"),
    mode: z.string().nullish().describe("How Slack holds the file, tombstone once it's deleted"),
    name: z.string().nullish().describe("The file's name, absent for a deleted or hidden file"),
    mimetype: z.string().nullish().describe("The file's MIME type"),
    size: z.number().int().nonnegative().nullish().describe("The file's size in bytes"),
  })
  .describe("A file attached to a message");

/** One message as history returns it, or as an edit nests it. Both carry no channel. */
export const slackMessageSchema = z
  .object({
    type: z.literal("message").optional().describe("Always message when present"),
    subtype: z.string().nullish().describe("Absent for an ordinary message"),
    ts: slackTsSchema.describe("The message's ID within its channel"),
    thread_ts: slackTsSchema.nullish().describe("The thread's root ts, equal to ts on a root"),
    user: slackIdSchema.nullish().describe("The author's user ID"),
    user_team: slackIdSchema.nullish().describe("The author's home team in a shared channel"),
    team: slackIdSchema.nullish().describe("The team the message belongs to"),
    bot_id: slackIdSchema.nullish().describe("Present when a bot posted it"),
    app_id: slackIdSchema.nullish().describe("Present when an app posted it"),
    text: z.string().nullish().describe("The message's text in Slack markup"),
    files: z.array(slackFileSchema).nullish().describe("The files attached to the message"),
    edited: z
      .object({ ts: slackTsSchema.describe("When the message was last edited") })
      .nullish()
      .describe("Present once the message has been edited"),
    latest_reply: slackTsSchema.nullish().describe("The newest reply's ts on a thread root"),
    hidden: z.boolean().nullish().describe("Set when Slack keeps the message from people"),
  })
  .describe("A Slack message");

const channelSchema = slackIdSchema.describe("The channel the message is in");
const bookkeepingSubtypes = new Set(["message_changed", "message_deleted", "message_replied"]);

/**
 * A message event from the Events API, tagged with its shape: a message posted,
 * edited or deleted, or a thread's reply bookkeeping.
 */
export const slackMessageEventSchema = z.union([
  z
    .object({
      type: z.literal("message"),
      subtype: z.literal("message_changed"),
      channel: channelSchema,
      message: slackMessageSchema.describe("The message as it is now"),
    })
    .describe("A message was edited")
    .transform(({ channel, message }) => ({ shape: "changed" as const, channel, message })),
  z
    .object({
      type: z.literal("message"),
      subtype: z.literal("message_deleted"),
      channel: channelSchema,
      deleted_ts: slackTsSchema.describe("The deleted message's ts"),
    })
    .describe("A message was deleted")
    .transform(({ channel, deleted_ts }) => ({
      shape: "deleted" as const,
      channel,
      deletedTs: deleted_ts,
    })),
  z
    .object({
      type: z.literal("message"),
      subtype: z.literal("message_replied"),
      channel: channelSchema,
      message: slackMessageSchema.describe("The thread's root with its reply metadata"),
    })
    .describe("A thread gained a reply")
    .transform(({ channel, message }) => ({ shape: "replied" as const, channel, message })),
  slackMessageSchema
    .extend({
      type: z.literal("message"),
      channel: channelSchema,
      subtype: z
        .string()
        .refine((subtype) => !bookkeepingSubtypes.has(subtype))
        .nullish()
        .describe("Absent for an ordinary message"),
    })
    .describe("A message was posted")
    .transform(({ channel, ...message }) => ({ shape: "posted" as const, channel, message })),
]);

export type SlackMessagePayload = z.output<typeof slackMessageSchema>;
export type SlackMessageEventPayload = z.output<typeof slackMessageEventSchema>;

/** Who wrote a message, as far as the payload and our identity can tell. */
export type MessageAuthor =
  /** A person's own message, which could become a request. */
  | "person"
  /** Our bot. */
  | "self"
  /** Another bot, an app, or Slackbot. */
  | "bot"
  /** A join, topic change or other notice, or a subtype the bridge doesn't know. */
  | "notice";

export type SlackFile = {
  id: string;
  name: string | null;
  mimetype: string | null;
  size: number | null;
};

/** A message in the one shape the ledger stores, whether it arrived live or from history. */
export type SlackMessage = {
  channelId: string;
  ts: SlackTs;
  /** As Slack sent it. A root can carry a thread_ts equal to its own ts. */
  threadTs: SlackTs | null;
  /** The thread this message belongs to: its root's ts, or its own ts when it isn't a reply. */
  rootTs: SlackTs;
  isReply: boolean;
  userId: string | null;
  /**
   * The author's workspace as the message names it, for display only. Trust never reads it,
   * because an Enterprise coworker can post from a sibling workspace.
   */
  teamId: string | null;
  subtype: string | null;
  author: MessageAuthor;
  text: string;
  files: SlackFile[];
  /** The people the text mentions, sorted and without repeats. Broadcasts and groups aren't people. */
  mentions: string[];
  mentionsBot: boolean;
  editedTs: SlackTs | null;
  /** Orders versions of the same message: the last edit's ts, or the message's own. */
  version: SlackTs;
  latestReplyTs: SlackTs | null;
};

/** What one message event says happened. */
export type SlackMessageEvent =
  /** A message as it is now. `edit` marks one that arrived as an edit. */
  | { kind: "message"; message: SlackMessage; edit: boolean }
  /**
   * Its author or an admin deleted the message. Slack deletes a root that still has replies by
   * leaving a tombstone in its place, and that counts too.
   */
  | { kind: "deleted"; channelId: string; ts: SlackTs }
  /**
   * Slack no longer shows what a message says, because an admin revoked its key or a data loss
   * prevention rule hid it. Only a delete says its author took it back.
   */
  | { kind: "withdrawn"; channelId: string; ts: SlackTs }
  /** A thread gained a reply. Only its bookkeeping changes, never its root's text. */
  | { kind: "replied"; channelId: string; threadTs: SlackTs; latestReplyTs: SlackTs | null };

/** The installation identity normalization reads authorship against. */
export type NormalizeContext = {
  botUserId: string;
  botId: string;
  /** Whether the user directory says `userId` is a bot user. */
  isBotUser(userId: string): boolean;
};

/** Normalizes a parsed message event. */
export function normalizeMessageEvent(
  event: SlackMessageEventPayload,
  context: NormalizeContext,
): SlackMessageEvent {
  switch (event.shape) {
    case "posted":
      return fromSnapshot(event.channel, event.message, context, false);
    case "changed":
      return fromSnapshot(event.channel, event.message, context, true);
    case "deleted":
      return { kind: "deleted", channelId: event.channel, ts: event.deletedTs };
    case "replied":
      return {
        kind: "replied",
        channelId: event.channel,
        threadTs: event.message.ts,
        latestReplyTs: event.message.latest_reply ?? null,
      };
  }
}

/** Normalizes a message that history returned for `channelId`. */
export function normalizeHistoryMessage(
  channelId: string,
  payload: SlackMessagePayload,
  context: NormalizeContext,
): SlackMessageEvent {
  return fromSnapshot(channelId, payload, context, false);
}

/** Subtypes a person posts directly. Every other subtype is a notice or another author's. */
const personSubtypes = new Set(["file_share", "me_message", "thread_broadcast"]);
const slackbotUserId = "USLACKBOT";
/** The author Slack names for content an admin revoked. users.info can't look it up. */
const revokedUserId = "UREVOKEDU";

function fromSnapshot(
  channelId: string,
  payload: SlackMessagePayload,
  context: NormalizeContext,
  edit: boolean,
): SlackMessageEvent {
  // A tombstone is hidden and Slackbot's, so it's read before anything that would take it for a
  // withdrawal or a bot's message. The root's message_deleted comes only after its last reply's.
  if (payload.subtype === "tombstone") return { kind: "deleted", channelId, ts: payload.ts };
  if (isWithdrawn(payload)) return { kind: "withdrawn", channelId, ts: payload.ts };

  const threadTs = payload.thread_ts ?? null;
  const isReply = threadTs !== null && threadTs !== payload.ts;
  const text = payload.text ?? "";
  const mentions = userMentions(text);
  return {
    kind: "message",
    edit,
    message: {
      channelId,
      ts: payload.ts,
      threadTs,
      rootTs: isReply ? threadTs : payload.ts,
      isReply,
      userId: payload.user ?? null,
      teamId: payload.user_team ?? payload.team ?? null,
      subtype: payload.subtype ?? null,
      author: messageAuthor(payload, context),
      text,
      // A deleted file stays in its message as a tombstone, which must never be indexed again.
      files: (payload.files ?? [])
        .filter((file) => file.mode !== "tombstone")
        .map((file) => ({
          id: file.id,
          name: file.name ?? null,
          mimetype: file.mimetype ?? null,
          size: file.size ?? null,
        })),
      mentions,
      mentionsBot: mentions.includes(context.botUserId),
      editedTs: payload.edited?.ts ?? null,
      version: payload.edited?.ts ?? payload.ts,
      latestReplyTs: payload.latest_reply ?? null,
    },
  };
}

/**
 * Whether Slack withheld a message's content. A snapshot like this keeps the original's ts, often
 * without a newer edit, and what text it has is Slack's placeholder. Only the message's own hidden
 * flag counts, since Slack hides every edit and delete event that carries one.
 */
function isWithdrawn(payload: SlackMessagePayload): boolean {
  return (
    payload.subtype === "ekm_access_denied" ||
    payload.hidden === true ||
    payload.user === revokedUserId
  );
}

function messageAuthor(payload: SlackMessagePayload, context: NormalizeContext): MessageAuthor {
  const subtype = payload.subtype ?? null;
  if (subtype !== null && subtype !== "bot_message" && !personSubtypes.has(subtype)) {
    return "notice";
  }
  if (payload.user === context.botUserId || payload.bot_id === context.botId) return "self";
  if (payload.bot_id || payload.app_id || subtype === "bot_message") return "bot";
  if (!payload.user) return "notice";
  if (payload.user === slackbotUserId || context.isBotUser(payload.user)) return "bot";
  return "person";
}

const userMentionPattern = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

function userMentions(text: string): string[] {
  const users = new Set(Array.from(text.matchAll(userMentionPattern), ([, user]) => user!));
  return [...users].sort();
}

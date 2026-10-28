import { z } from "zod";
import { issuesOf, type Authorization, type EventCallback } from "./envelopes";
import type { Installation } from "./installation";
import { slackMessageEventSchema, type SlackMessageEventPayload } from "./messages";

// Events API events.
//
// The receiver reads the event inside each event_callback here, once the frame is read. Every type
// the manifest subscribes to has a schema, a message is normalized later against the link that
// watches its channel, and any other type is passed on by name. Routing decides whether an event
// is ours before any of it is applied. v1 supports one dedicated app installed in exactly one
// workspace, so an event is ours when Slack delivered it to our bot in that workspace, whichever
// workspace it happened in.

const slackIdSchema = z.string().min(1);
const channelIdSchema = slackIdSchema.describe("The channel's ID");

/** One event the bridge acts on, as its handler needs it. */
export type SlackEvent =
  /** A message posted, edited or deleted, or a thread's reply bookkeeping. */
  | { kind: "message"; payload: SlackMessageEventPayload }
  | { kind: "membership"; change: "joined" | "left"; channelId: string; userId: string }
  | { kind: "channel"; change: ChannelChange; channelId: string }
  /** Slack gives a private channel a new ID when it's shared outside the workspace. */
  | { kind: "channel_id_changed"; oldChannelId: string; newChannelId: string }
  /** It names no channel. */
  | { kind: "file_deleted"; fileId: string }
  | { kind: "uninstalled" }
  /** The bot users whose tokens were revoked, which can be someone else's bot in the workspace. */
  | { kind: "tokens_revoked"; botUserIds: string[] }
  /** A type the manifest doesn't subscribe to. */
  | { kind: "other"; type: string }
  /** `issues` names codes and paths only. `channelId` is the event's channel when it names one. */
  | { kind: "malformed"; issues: string[]; channelId: string | null };

/** A change to a channel that only its type tells apart. */
export type ChannelChange = "archived" | "deleted" | "renamed" | "shared" | "unshared";

function membershipEvent(change: "joined" | "left") {
  return z
    .object({
      user: slackIdSchema.describe("The member who joined or left"),
      channel: channelIdSchema,
    })
    .describe("A member joined or left a channel")
    .transform(({ user, channel }) => ({
      kind: "membership" as const,
      change,
      channelId: channel,
      userId: user,
    }));
}

function channelEvent(change: Exclude<ChannelChange, "renamed">) {
  return z
    .object({ channel: channelIdSchema })
    .describe("A channel was archived, deleted, shared or unshared")
    .transform(({ channel }) => ({ kind: "channel" as const, change, channelId: channel }));
}

const renameEvent = z
  .object({
    channel: z
      .object({ id: channelIdSchema })
      .describe("The renamed channel, which a rename carries as an object"),
  })
  .describe("A channel was renamed")
  .transform(({ channel }) => ({
    kind: "channel" as const,
    change: "renamed" as const,
    channelId: channel.id,
  }));

const eventSchemas = {
  message: slackMessageEventSchema.transform((payload) => ({ kind: "message" as const, payload })),
  member_joined_channel: membershipEvent("joined"),
  member_left_channel: membershipEvent("left"),
  channel_archive: channelEvent("archived"),
  channel_deleted: channelEvent("deleted"),
  group_deleted: channelEvent("deleted"),
  channel_rename: renameEvent,
  group_rename: renameEvent,
  channel_shared: channelEvent("shared"),
  channel_unshared: channelEvent("unshared"),
  channel_id_changed: z
    .object({
      old_channel_id: channelIdSchema.describe("The ID the channel had"),
      new_channel_id: channelIdSchema.describe("The ID the channel has now"),
    })
    .describe("Slack gave a channel a new ID")
    .transform((event) => ({
      kind: "channel_id_changed" as const,
      oldChannelId: event.old_channel_id,
      newChannelId: event.new_channel_id,
    })),
  file_deleted: z
    .object({ file_id: slackIdSchema.describe("The deleted file's ID") })
    .describe("A file was deleted")
    .transform((event) => ({ kind: "file_deleted" as const, fileId: event.file_id })),
  app_uninstalled: z
    .object({})
    .describe("The app was uninstalled from the workspace")
    .transform(() => ({ kind: "uninstalled" as const })),
  tokens_revoked: z
    .object({
      tokens: z
        .object({
          bot: z.array(slackIdSchema).nullish().describe("The bot users whose tokens were revoked"),
        })
        .describe("The revoked tokens, by the user they belonged to"),
    })
    .describe("Tokens for the app were revoked")
    .transform((event) => ({
      kind: "tokens_revoked" as const,
      botUserIds: event.tokens.bot ?? [],
    })),
} satisfies Record<string, z.ZodType<SlackEvent>>;

/** The event types the manifest subscribes to. */
export const handledEventTypes: ReadonlySet<string> = new Set(Object.keys(eventSchemas));

/** Reads the event inside a callback. Never throws. */
export function readSlackEvent(event: EventCallback["event"]): SlackEvent {
  if (!Object.hasOwn(eventSchemas, event.type)) return { kind: "other", type: event.type };
  const schema: z.ZodType<SlackEvent> = eventSchemas[event.type as keyof typeof eventSchemas];
  const read = schema.safeParse(event);
  if (read.success) return read.data;
  return {
    kind: "malformed",
    issues: issuesOf(read.error, ["event"]),
    channelId: channelOf(event),
  };
}

/** What routing compares a delivery against. */
export type RoutingIdentity = Pick<Installation, "appId" | "teamId" | "botUserId" | "enterpriseId">;

// Their references tie them to the workspace that uninstalled the app or revoked its tokens, and an
// uninstall's authorization needn't be the bot's, so they go by the callback's team.
const workspaceEventTypes: ReadonlySet<string> = new Set(["app_uninstalled", "tokens_revoked"]);

/**
 * Whether Slack delivered an event to our installation. Only an event that leaves its
 * authorizations out falls back to the callback's team, and only for a type the bridge handles,
 * because an empty or foreign list says the event belongs to someone else.
 */
export function isForInstallation(callback: EventCallback, installation: RoutingIdentity): boolean {
  if (callback.appId !== installation.appId) return false;
  const type = callback.event.type;
  if (workspaceEventTypes.has(type)) return callback.teamId === installation.teamId;
  if (callback.authorizations === null) {
    return handledEventTypes.has(type) && callback.teamId === installation.teamId;
  }
  return callback.authorizations.some((authorization) => isOurBot(authorization, installation));
}

function isOurBot(authorization: Authorization, installation: RoutingIdentity): boolean {
  return (
    authorization.isBot &&
    !authorization.isEnterpriseInstall &&
    authorization.teamId === installation.teamId &&
    authorization.userId === installation.botUserId &&
    (authorization.enterpriseId === null ||
      authorization.enterpriseId === installation.enterpriseId)
  );
}

const channelHintSchema = z.object({ channel: slackIdSchema });

function channelOf(event: unknown): string | null {
  return channelHintSchema.safeParse(event).data?.channel ?? null;
}

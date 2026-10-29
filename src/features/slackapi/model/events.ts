import { z } from "zod";
import { issuesOf, type EventCallback } from "./envelopes";
import type { Installation } from "./installation";
import { slackMessageEventSchema, type SlackMessageEventPayload } from "./messages";

export type ChannelChange = "archived" | "deleted" | "shared";
export type SlackEvent =
  | { kind: "message"; payload: SlackMessageEventPayload }
  | { kind: "member_left"; channelId: string; userId: string }
  | { kind: "channel"; change: ChannelChange; channelId: string }
  | { kind: "channel_id_changed"; oldChannelId: string; newChannelId: string }
  | { kind: "uninstalled" }
  | { kind: "tokens_revoked"; botUserIds: string[] }
  | { kind: "other" }
  | { kind: "malformed"; issues: string[]; channelId: string | null };
export type RoutingIdentity = Pick<Installation, "appId" | "teamId" | "botUserId" | "enterpriseId">;

const id = z.string().min(1);
const channelChanges: Record<string, ChannelChange> = {
  channel_archive: "archived",
  channel_deleted: "deleted",
  group_deleted: "deleted",
  channel_shared: "shared",
};
const channelSchema = z.object({ channel: id.describe("Channel") });
const membershipSchema = z.object({ channel: id.describe("Channel"), user: id.describe("Member") });
const movedSchema = z.object({
  old_channel_id: id.describe("Old channel ID"),
  new_channel_id: id.describe("New channel ID"),
});
const revokedSchema = z.object({
  tokens: z.object({ bot: z.array(id).nullish().describe("Bot users whose tokens were revoked") }),
});
export const handledEventTypes: ReadonlySet<string> = new Set([
  ...Object.keys(channelChanges),
  "message",
  "member_left_channel",
  "channel_id_changed",
  "app_uninstalled",
  "tokens_revoked",
]);

export function readSlackEvent(event: EventCallback["event"]): SlackEvent {
  const channelChange = channelChanges[event.type];
  if (!handledEventTypes.has(event.type)) return { kind: "other" };
  try {
    if (event.type === "message")
      return { kind: "message", payload: slackMessageEventSchema.parse(event) };
    if (event.type === "app_uninstalled") return { kind: "uninstalled" };
    if (event.type === "tokens_revoked")
      return { kind: "tokens_revoked", botUserIds: revokedSchema.parse(event).tokens.bot ?? [] };
    if (event.type === "channel_id_changed") {
      const moved = movedSchema.parse(event);
      return {
        kind: "channel_id_changed",
        oldChannelId: moved.old_channel_id,
        newChannelId: moved.new_channel_id,
      };
    }
    if (channelChange) {
      const { channel } = channelSchema.parse(event);
      return { kind: "channel", change: channelChange, channelId: channel };
    }
    const member = membershipSchema.parse(event);
    return { kind: "member_left", channelId: member.channel, userId: member.user };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return {
      kind: "malformed",
      issues: issuesOf(error, ["event"]),
      channelId: channelSchema.safeParse(event).data?.channel ?? null,
    };
  }
}

/** Route by the receiving installation, never a coworker's sibling workspace. */
export function isForInstallation(callback: EventCallback, installation: RoutingIdentity): boolean {
  if (callback.appId !== installation.appId) return false;
  if (["app_uninstalled", "tokens_revoked"].includes(callback.event.type))
    return callback.teamId === installation.teamId;
  if (callback.authorizations === null)
    return handledEventTypes.has(callback.event.type) && callback.teamId === installation.teamId;
  return callback.authorizations.some(
    (auth) =>
      auth.isBot &&
      !auth.isEnterpriseInstall &&
      auth.teamId === installation.teamId &&
      auth.userId === installation.botUserId &&
      (auth.enterpriseId === null || auth.enterpriseId === installation.enterpriseId),
  );
}

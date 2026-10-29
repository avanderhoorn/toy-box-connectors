import { z } from "zod";
import type { Installation } from "./installation";

export type TokenName = "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN";
export type SlackIdentity = Pick<
  Installation,
  "teamId" | "enterpriseId" | "appId" | "botId" | "botUserId"
>;
export type TokenOwner = {
  workspaceUrl: string | null;
  teamId: string;
  enterpriseId: string | null;
  userId: string;
  botId: string | null;
  orgWide: boolean;
  rotates: boolean;
};
export type BotOwner = TokenOwner & { botId: string };
export type BotInfo = { appId: string; userId: string };
export type IdentityRefusal =
  | { reason: "uninstalled" | "org_wide" | "not_bot" | "rotating" | "moved_org" | "other_app" }
  | { reason: "mismatch"; field: "teamId" | "appId" | "botId" | "botUserId"; found: string };

export const authTestSchema = z
  .object({
    url: z.string().nullish().describe("Workspace URL"),
    team_id: z.string().min(1).describe("Installation workspace"),
    enterprise_id: z.string().nullish().describe("Enterprise org, if any"),
    user_id: z.string().min(1).describe("Token user"),
    bot_id: z.string().min(1).nullish().describe("Token bot"),
    is_enterprise_install: z.boolean().nullish().describe("Org-wide installation"),
    expires_in: z.number().nullish().describe("Rotating token lifetime"),
  })
  .transform((value): TokenOwner => ({
    workspaceUrl: value.url ?? null,
    teamId: value.team_id,
    enterpriseId: value.enterprise_id || null,
    userId: value.user_id,
    botId: value.bot_id ?? null,
    orgWide: value.is_enterprise_install === true,
    rotates: value.expires_in != null,
  }));
export const botInfoSchema = z
  .object({
    bot: z.object({
      app_id: z.string().min(1).describe("Bot app"),
      user_id: z.string().min(1).describe("Bot user"),
    }),
  })
  .transform(({ bot }): BotInfo => ({ appId: bot.app_id, userId: bot.user_id }));

export function tokensRefusal(tokens: {
  botToken: string;
  appToken: string;
}): IdentityRefusal | null {
  return tokens.botToken.startsWith("xoxe.") || tokens.appToken.startsWith("xoxe.")
    ? { reason: "rotating" }
    : null;
}

export function checkOwner(
  owner: TokenOwner,
): { kind: "bot"; owner: BotOwner } | { kind: "refused"; refusal: IdentityRefusal } {
  if (owner.rotates) return { kind: "refused", refusal: { reason: "rotating" } };
  if (owner.orgWide) return { kind: "refused", refusal: { reason: "org_wide" } };
  if (owner.botId === null) return { kind: "refused", refusal: { reason: "not_bot" } };
  return { kind: "bot", owner: { ...owner, botId: owner.botId } };
}

export function identityOf(owner: BotOwner, bot: BotInfo): SlackIdentity | null {
  return bot.userId === owner.userId
    ? {
        teamId: owner.teamId,
        enterpriseId: owner.enterpriseId,
        appId: bot.appId,
        botId: owner.botId,
        botUserId: owner.userId,
      }
    : null;
}

export function identityRefusal(
  stored: SlackIdentity,
  found: SlackIdentity,
): IdentityRefusal | null {
  for (const field of ["teamId", "appId", "botId", "botUserId"] as const) {
    if (stored[field] !== found[field]) return { reason: "mismatch", field, found: found[field] };
  }
  return stored.enterpriseId === found.enterpriseId ? null : { reason: "moved_org" };
}

export function helloRefusal(appId: string, helloAppId: string | null): IdentityRefusal | null {
  return helloAppId === appId ? null : { reason: "other_app" };
}

export function refusalProblem(refusal: IdentityRefusal): string {
  if (refusal.reason === "uninstalled")
    return "Slack was uninstalled. Stop the bridge and remove bridge.db and its -wal/-shm files before installing again.";
  const detail = "field" in refusal ? `${refusal.field}: ${refusal.found}` : refusal.reason;
  return `Slack identity refused (${detail}). Check credentials.env and the stored installation, then restart.`;
}

export function rejectedTokenProblem(token: TokenName, error: string): string {
  return `Slack rejected ${token}: ${error}. Fix credentials.env or the workspace policy, then restart.`;
}

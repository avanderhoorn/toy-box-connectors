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

// What the owner does about tokens the bridge can't use. Only the owner can, at a terminal, since
// `serve` never asks in a lead's shell. Deleting a token's line makes `serve` ask for it again, and
// when a bridge is already running, that `serve` saves the answer and stops, so restarting the
// running bridge is what reads it.

/** What Slack is refusing, and what the owner does about it. */
export function refusalProblem(refusal: IdentityRefusal): string {
  switch (refusal.reason) {
    case "uninstalled":
      return "Slack was uninstalled. To install it again, have the owner stop the bridge, remove bridge.db and its -wal/-shm files, delete the SLACK_BOT_TOKEN line from the bridge's credentials.env, install the app in Slack again, and run `toy-box-slack serve` at their own terminal, which asks for its new bot token.";
    case "not_bot":
      return `SLACK_BOT_TOKEN isn't a bot token. Have the owner ${replace(["SLACK_BOT_TOKEN"])}.`;
    case "other_app":
      return `SLACK_APP_TOKEN belongs to another Slack app than SLACK_BOT_TOKEN. Have the owner ${replace(["SLACK_APP_TOKEN"])}.`;
    case "org_wide":
      return `SLACK_BOT_TOKEN is from an install across an Enterprise org, which the bridge doesn't support. Have the owner install the app in one workspace, ${replace(["SLACK_BOT_TOKEN"])}.`;
    case "rotating":
      return `The Slack app's tokens rotate, which the bridge doesn't support, and token rotation can't be turned off once it's on. Have the owner create a Slack app from docs/manifest.yaml, ${replace(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], "the new app's tokens")}.`;
    case "moved_org":
      return `The workspace joined or left an Enterprise org since the bridge was set up. The bridge has to start over, which forgets every link, so have the owner ${startOver}.`;
    case "mismatch": {
      const other = belongings[refusal.field];
      return `SLACK_BOT_TOKEN belongs to another ${other} (${refusal.found}) than the one the bridge was set up for. Have the owner ${replace(["SLACK_BOT_TOKEN"])}. To move the bridge to that ${other} instead, which forgets every link, have the owner ${startOver}.`;
    }
  }
}

/** What the owner does about the tokens Slack rejected, each with the error Slack gave. */
export function rejectedTokensProblem(rejected: readonly (readonly [TokenName, string])[]): string {
  const errors = rejected.map(([token, error]) => `${token} with ${error}`);
  return `Slack rejected ${list(errors)}. Have the owner ${replace(rejected.map(([token]) => token))}.`;
}

/** What the owner does about the tokens the bridge doesn't have. */
export function missingTokensProblem(missing: readonly TokenName[]): string {
  return `Have the owner ${askFor(list(missing))}.`;
}

const belongings = {
  teamId: "workspace",
  appId: "Slack app",
  botId: "bot",
  botUserId: "bot user",
} satisfies Record<Extract<IdentityRefusal, { reason: "mismatch" }>["field"], string>;

const startOver = "stop the bridge, remove bridge.db and its -wal/-shm files, and start it again";

/** Deleting each of `tokens`, so `serve` asks for `asked`, by default each one again. */
function replace(
  tokens: readonly TokenName[],
  asked = tokens.length === 1 ? "it again" : "them again",
): string {
  const lines = `${list(tokens)} ${tokens.length === 1 ? "line" : "lines"}`;
  return `delete the ${lines} from the bridge's credentials.env, ${askFor(asked)}`;
}

function askFor(asked: string): string {
  return `run \`toy-box-slack serve\` at their own terminal, which asks for ${asked}, and then restart the bridge`;
}

function list(items: readonly string[]): string {
  return new Intl.ListFormat("en").format(items);
}

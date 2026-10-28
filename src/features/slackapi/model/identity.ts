import { z } from "zod";
import { isOrgMigration } from "./errors";
import type { Installation } from "./installation";

// Whose tokens the bridge holds.
//
// Before the bridge reads or sends anything, at startup and when Slack takes back a bot token it
// rejected, it asks Slack whose tokens these are and holds the answer against the installation.
// auth.test names the workspace, its Enterprise org, the bot user and the bot but not reliably the
// app, which bots.info gives, and Socket Mode's hello names the app the app-level token belongs to.
// v1 supports one workspace install with token rotation off, so a rotating token or an org-wide
// install is refused rather than half supported. Any difference from the installation is refused
// too, including a workspace that joined, left or changed Enterprise org, because the people the
// bridge admitted were checked against the old one.

/** A token the bridge reads from its environment. */
export type TokenName = "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN";

/** Who the installation belongs to, which the tokens must go on agreeing with. */
export type SlackIdentity = Pick<
  Installation,
  "teamId" | "enterpriseId" | "appId" | "botId" | "botUserId"
>;

/** Whose token this is, as auth.test describes it. */
export type TokenOwner = {
  /** The workspace's address, such as https://acme.slack.com/, or null when Slack didn't say. */
  workspaceUrl: string | null;
  teamId: string;
  /** The workspace's Enterprise org, or null for a standalone workspace. */
  enterpriseId: string | null;
  /** The token's user, which is our bot user for a bot token. */
  userId: string;
  /** The token's bot, or null when it isn't a bot token. */
  botId: string | null;
  /** The app was installed across an Enterprise org, rather than to one workspace. */
  orgWide: boolean;
  /** The token expires, so token rotation is on. */
  rotates: boolean;
};

/** Why the bridge won't use Slack with these tokens until the operator acts. */
export type IdentityRefusal =
  /** Slack said the app was uninstalled or our bot's token revoked, and the bridge purged. */
  | { reason: "uninstalled" }
  | { reason: "rotating"; tokens: readonly TokenName[] }
  /** The bot token comes from an install across an Enterprise org. */
  | { reason: "org_wide" }
  /** SLACK_BOT_TOKEN is another kind of token, such as a user token. */
  | { reason: "not_bot" }
  /** The bot token belongs to another workspace, app or bot than the installation. */
  | {
      reason: "mismatch";
      field: "teamId" | "appId" | "botId" | "botUserId";
      stored: string;
      found: string;
    }
  /** The workspace joined, left or changed Enterprise org since the installation was recorded. */
  | { reason: "moved_org"; stored: string | null; found: string | null }
  /** Socket Mode's hello names another app than the installation's, or none. */
  | { reason: "other_app"; stored: string; found: string | null };

const slackIdSchema = z.string().min(1);

/** auth.test's answer, read into whose token it is. */
export const authTestSchema = z
  .object({
    url: z.string().min(1).nullish().describe("The workspace's address"),
    team_id: slackIdSchema.describe("The workspace the token belongs to"),
    enterprise_id: z
      .string()
      .nullish()
      .describe("The workspace's Enterprise org, absent or empty outside one"),
    user_id: slackIdSchema.describe("The token's user, our bot user for a bot token"),
    bot_id: slackIdSchema.nullish().describe("The token's bot, absent for a user token"),
    is_enterprise_install: z
      .boolean()
      .nullish()
      .describe("The app was installed across an Enterprise org"),
    expires_in: z.number().nullish().describe("Seconds until a rotating token expires"),
  })
  .describe("auth.test's answer")
  .transform((answer): TokenOwner => ({
    workspaceUrl: answer.url ?? null,
    teamId: answer.team_id,
    enterpriseId: answer.enterprise_id || null,
    userId: answer.user_id,
    botId: answer.bot_id ?? null,
    orgWide: answer.is_enterprise_install === true,
    rotates: answer.expires_in != null,
  }));

/** The bot bots.info describes. */
export type BotInfo = {
  /** The app the bot belongs to. */
  appId: string;
  /** The bot's user, which must be the token's. */
  userId: string;
};

/** bots.info's answer, read into the bot's app and user. */
export const botInfoSchema = z
  .object({
    bot: z
      .object({
        app_id: slackIdSchema.describe("The app the bot belongs to"),
        user_id: slackIdSchema.describe("The bot's user"),
      })
      .describe("The bot"),
  })
  .describe("bots.info's answer")
  .transform(({ bot }): BotInfo => ({ appId: bot.app_id, userId: bot.user_id }));

/** Refuses tokens that rotate, which start with `xoxe.`, before asking Slack anything. */
export function tokensRefusal(tokens: {
  botToken: string;
  appToken: string;
}): IdentityRefusal | null {
  const rotating: TokenName[] = [
    ...(tokens.botToken.startsWith("xoxe.") ? ["SLACK_BOT_TOKEN" as const] : []),
    ...(tokens.appToken.startsWith("xoxe.") ? ["SLACK_APP_TOKEN" as const] : []),
  ];
  return rotating.length === 0 ? null : { reason: "rotating", tokens: rotating };
}

/** A bot token's owner, which names its bot. */
export type BotOwner = TokenOwner & { botId: string };

/**
 * Checks a bot token's owner for what v1 supports, refusing a token that expires, one from an
 * org-wide install, and one that isn't a bot's.
 */
export function checkOwner(
  owner: TokenOwner,
): { kind: "bot"; owner: BotOwner } | { kind: "refused"; refusal: IdentityRefusal } {
  if (owner.rotates)
    return { kind: "refused", refusal: { reason: "rotating", tokens: ["SLACK_BOT_TOKEN"] } };
  if (owner.orgWide) return { kind: "refused", refusal: { reason: "org_wide" } };
  const { botId } = owner;
  if (botId === null) return { kind: "refused", refusal: { reason: "not_bot" } };
  return { kind: "bot", owner: { ...owner, botId } };
}

/**
 * Who a bot token's `owner` is, with the app bots.info named for its bot. When bots.info describes
 * another bot user than the token's, its app can't be taken for the token's, so there's no answer.
 */
export function identityOf(owner: BotOwner, bot: BotInfo): SlackIdentity | null {
  if (bot.userId !== owner.userId) return null;
  return {
    teamId: owner.teamId,
    enterpriseId: owner.enterpriseId,
    appId: bot.appId,
    botId: owner.botId,
    botUserId: owner.userId,
  };
}

/**
 * Refuses an identity that disagrees with the stored one. Another workspace says the most, so it's
 * named first, then the app, the bot and its user, and then a change of Enterprise org alone.
 */
export function identityRefusal(
  stored: SlackIdentity,
  found: SlackIdentity,
): IdentityRefusal | null {
  for (const field of ["teamId", "appId", "botId", "botUserId"] as const) {
    if (stored[field] !== found[field]) {
      return { reason: "mismatch", field, stored: stored[field], found: found[field] };
    }
  }
  if (stored.enterpriseId !== found.enterpriseId) {
    return { reason: "moved_org", stored: stored.enterpriseId, found: found.enterpriseId };
  }
  return null;
}

/** Refuses an app-level token unless Socket Mode's hello names the installation's app. */
export function helloRefusal(appId: string, helloAppId: string | null): IdentityRefusal | null {
  return helloAppId === appId ? null : { reason: "other_app", stored: appId, found: helloAppId };
}

const resetStep = "stop the bridge and run `toy-box-slack reset --yes`";

/** Where each token comes from, as an instruction to put it in credentials.env names it. */
const tokenSources: Record<TokenName, string> = {
  SLACK_BOT_TOKEN: "the app's Bot User OAuth Token, which starts with xoxb-,",
  SLACK_APP_TOKEN:
    "an app-level token with connections:write from the app's Basic Information page, which starts with xapp-,",
};

function replaceStep(token: TokenName): string {
  return `Put ${tokenSources[token]} in credentials.env, then restart the bridge.`;
}

const fieldNouns = {
  teamId: "workspace",
  appId: "app",
  botId: "bot",
  botUserId: "bot user",
} as const;

/** What's wrong and how the operator fixes it, as status shows it. */
export function refusalProblem(refusal: IdentityRefusal): string {
  switch (refusal.reason) {
    case "uninstalled":
      return `Slack said the app was uninstalled or its bot token revoked, so the bridge deleted what it held from Slack. To use it again, reinstall the app and put its tokens in credentials.env, then ${resetStep}.`;
    case "rotating": {
      const verb = refusal.tokens.length === 1 ? "rotates" : "rotate";
      return `${refusal.tokens.join(" and ")} ${verb}, and the bridge needs tokens with rotation off. Rotation can't be turned off once it's on, so create a new app from docs/manifest.yaml, which leaves it off, install it to the workspace and put its tokens in credentials.env, then restart the bridge.`;
    }
    case "org_wide":
      return "SLACK_BOT_TOKEN comes from an install across an Enterprise org, and the bridge needs the app installed to one workspace. Install an app made from docs/manifest.yaml, which leaves org-wide deployment off, to the workspace and put its tokens in credentials.env, then restart the bridge.";
    case "not_bot":
      return `SLACK_BOT_TOKEN isn't a bot token. ${replaceStep("SLACK_BOT_TOKEN")}`;
    case "mismatch": {
      const noun = fieldNouns[refusal.field];
      return `SLACK_BOT_TOKEN belongs to ${noun} ${refusal.found}, but the bridge was set up with ${noun} ${refusal.stored}. Put back the tokens it was set up with and restart the bridge, or ${resetStep} to start over with these.`;
    }
    case "moved_org":
      return `The workspace ${orgChange(refusal.stored, refusal.found)} since the bridge was set up, so the people it admitted were checked against the old org. To set it up again, ${resetStep}.`;
    case "other_app":
      return refusal.found === null
        ? `Slack didn't say which app SLACK_APP_TOKEN belongs to, so the bridge can't confirm it's app ${refusal.stored}, which SLACK_BOT_TOKEN belongs to. Restart the bridge to ask again.`
        : `SLACK_APP_TOKEN belongs to app ${refusal.found}, but SLACK_BOT_TOKEN to app ${refusal.stored}. Put an app-level token from app ${refusal.stored}'s Basic Information page in credentials.env, then restart the bridge.`;
  }
}

/**
 * What's wrong and how the operator fixes it while Slack rejects `token` with `error`, as status
 * shows it. The bridge goes on asking meanwhile, so a workspace moving into an Enterprise org only
 * has to finish moving.
 */
export function rejectedTokenProblem(token: TokenName, error: string): string {
  if (isOrgMigration(error)) {
    return `Slack is moving the workspace into an Enterprise org and rejects ${token} with ${error} until that's done.`;
  }
  return `Slack rejected ${token} with ${error}. ${replaceStep(token)}`;
}

function orgChange(stored: string | null, found: string | null): string {
  if (stored === null) return `joined Enterprise org ${found}`;
  if (found === null) return `left Enterprise org ${stored}`;
  return `moved from Enterprise org ${stored} to ${found}`;
}

import type { WebClient } from "@slack/web-api";
import {
  authTestSchema,
  botInfoSchema,
  type BotInfo,
  type TokenOwner,
} from "@slackapi/model/identity";

/** Asks auth.test whose token `client` holds. Throws a ZodError when the answer can't be read. */
export async function fetchTokenOwner(client: WebClient): Promise<TokenOwner> {
  return authTestSchema.parse(await client.auth.test());
}

/**
 * Asks bots.info which app and user `botId` belongs to. Throws a ZodError when the answer can't be
 * read.
 */
export async function fetchBotInfo(client: WebClient, botId: string): Promise<BotInfo> {
  return botInfoSchema.parse(await client.bots.info({ bot: botId }));
}

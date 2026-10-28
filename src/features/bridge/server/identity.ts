import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { BridgeDatabase } from "@bridge/server/database";
import {
  checkOwner,
  identityOf,
  identityRefusal,
  tokensRefusal,
  type IdentityRefusal,
} from "@slackapi/model/identity";
import type { Installation } from "@slackapi/model/installation";
import type { BotClient, SlackCall } from "@slackapi/server/botClient";
import { fetchBotInfo, fetchTokenOwner } from "@slackapi/server/identity";
import {
  reactivateInstallation,
  readInstallation,
  recordInstallation,
} from "@slackapi/server/installation";

// Confirming the tokens.
//
// Startup asks Slack whose tokens the bridge holds before it reads or sends anything, and so does
// recovery after Slack rejected the bot token. The first answer records the installation, and every
// later one must agree with it. An answer the bridge can't get or can't read decides nothing.

/** What Slack said about the tokens. */
export type IdentityVerdict =
  /** The tokens are the installation's, which is active now. */
  | { kind: "confirmed"; installation: Installation; workspaceUrl: string | null }
  /** The bridge won't use Slack with these tokens until the operator acts. */
  | { kind: "refused"; refusal: IdentityRefusal }
  /** Slack rejected the bot token with `error`. */
  | { kind: "auth_failed"; error: string }
  /** Slack couldn't be asked, or its answer couldn't be read. `retryAt` is when Slack said to ask again. */
  | { kind: "unavailable"; detail: string; retryAt: number | null };

/** Asks Slack whose tokens these are, and records or reactivates the installation they confirm. */
export async function confirmIdentity(
  database: BridgeDatabase,
  bot: BotClient,
  tokens: { botToken: string; appToken: string },
): Promise<IdentityVerdict> {
  const rotating = tokensRefusal(tokens);
  if (rotating !== null) return { kind: "refused", refusal: rotating };
  if ((await database.read(readInstallation))?.status === "uninstalled") return uninstalled;

  const asked = await ask(bot, "auth.test", fetchTokenOwner);
  if (asked.kind !== "ok") return asked;
  const checked = checkOwner(asked.result);
  if (checked.kind === "refused") return checked;
  const { owner } = checked;
  const described = await ask(bot, "bots.info", (client) => fetchBotInfo(client, owner.botId));
  if (described.kind !== "ok") return described;
  const found = identityOf(owner, described.result);
  if (found === null) {
    return unavailable(
      `Slack's auth.test names bot user ${owner.userId} but bots.info ${described.result.userId}`,
    );
  }

  return database.write(async (transaction): Promise<IdentityVerdict> => {
    // Slack may have uninstalled the app, or the bridge recorded the installation, since it read.
    const stored = await readInstallation(transaction);
    if (stored?.status === "uninstalled") return uninstalled;
    const refusal = stored === null ? null : identityRefusal(stored, found);
    if (refusal !== null) return { kind: "refused", refusal };
    if (stored === null) await recordInstallation(transaction, found);
    await reactivateInstallation(transaction);
    const installation: Installation = { ...found, status: "active" };
    return { kind: "confirmed", installation, workspaceUrl: owner.workspaceUrl };
  });
}

const uninstalled: IdentityVerdict = { kind: "refused", refusal: { reason: "uninstalled" } };

type Asked<Result> =
  | { kind: "ok"; result: Result }
  | Extract<IdentityVerdict, { kind: "auth_failed" | "unavailable" }>;

/** Makes one call through the bot's client, reading anything but an answer as why it decides nothing. */
async function ask<Result>(
  bot: BotClient,
  method: string,
  run: (client: WebClient) => Promise<Result>,
): Promise<Asked<Result>> {
  let call: SlackCall<Result>;
  try {
    call = await bot.call(method, run);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return unavailable(`Slack answered ${method} with something the bridge can't read`);
  }
  switch (call.kind) {
    case "ok":
    case "auth_failed":
      return call;
    case "unusable":
      return unavailable(`The bridge cannot use Slack for ${method} right now`);
    case "rate_limited":
      return unavailable(`Slack is holding back ${method}`, call.until);
    case "error":
      return unavailable(`Slack refused ${method} with ${call.error}`);
    case "unknown":
      return unavailable(`Slack didn't answer ${method}: ${call.detail}`);
  }
}

function unavailable(
  detail: string,
  retryAt: number | null = null,
): Extract<IdentityVerdict, { kind: "unavailable" }> {
  return { kind: "unavailable", detail, retryAt };
}

import type { BridgeDatabase } from "@bridge/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { log as bridgeLog, type Log } from "@/shared/log";
import { nextOwedAttempt } from "../model/delivery";
import { judgeReaction, reactionChanges } from "../model/reactions";
import { deferDisplay, forgetDisplay, type OwedDisplay } from "./displays";

export function createReactions(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now, log = bridgeLog }: { now?: () => number; log?: Log } = {},
) {
  /**
   * Brings a message to the display the bridge owes it, and owes it again later while Slack doesn't
   * answer. Returns whether Slack held it back, so the pass leaves the rest for the next.
   */
  async function settle(owed: OwedDisplay): Promise<{ held: boolean }> {
    for (const { change, name } of reactionChanges(owed.shows)) {
      const call = await bot.call(`reactions.${change}`, (client) =>
        client.reactions[change]({ channel: owed.channelId, timestamp: owed.sourceTs, name }),
      );
      const outcome = judgeReaction(call);
      if (outcome === "held") return { held: true };
      if (outcome === "done") continue;
      const next = nextOwedAttempt(owed.owedAt, owed.attempts, now());
      if (next === null)
        log(
          `Gave up setting the reactions on Slack message ${owed.sourceTs} in ${owed.channelId} after trying for 30 days.`,
        );
      await database.write((tx) =>
        next === null ? forgetDisplay(tx, owed) : deferDisplay(tx, owed, next),
      );
      return { held: true };
    }
    await database.write((tx) => forgetDisplay(tx, owed));
    return { held: false };
  }
  return { settle };
}

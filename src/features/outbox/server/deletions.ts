import type { BridgeDatabase } from "@bridge/server/database";
import { judgeDeletion, type Deletion } from "@slackapi/model/uploads";
import type { BotClient } from "@slackapi/server/botClient";
import { log as bridgeLog, type Log } from "@/shared/log";
import { nextDeletion } from "../model/delivery";
import { deferDeletion, forgetDeletion, type OwedDeletion } from "./files";

/** Asks Slack to delete a file the bot uploaded. */
export async function deleteFile(bot: BotClient, fileId: string): Promise<Deletion> {
  return judgeDeletion(
    await bot.call("files.delete", (client) => client.files.delete({ file: fileId })),
  );
}

export function createFileDeletion(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now, log = bridgeLog }: { now?: () => number; log?: Log } = {},
) {
  /** Tries a delete the bridge owes, and owes it again later while Slack keeps the file. */
  async function settle(owed: OwedDeletion): Promise<Deletion> {
    const deletion = await deleteFile(bot, owed.fileId);
    const next =
      deletion.kind === "kept" ? nextDeletion(owed.createdAt, owed.attempts, now()) : null;
    if (deletion.kind === "kept" && next === null)
      log(`Gave up deleting Slack file ${owed.fileId} after trying for 30 days.`);
    await database.write((tx) =>
      next === null ? forgetDeletion(tx, owed.fileId) : deferDeletion(tx, owed.fileId, next),
    );
    return deletion;
  }
  return { settle };
}

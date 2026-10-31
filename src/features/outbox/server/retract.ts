import type { BridgeDatabase } from "@bridge/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { deleteReceipt } from "../model/delivery";
import { OutboxRefusedError, readOutboxItem } from "./database";
import { oweItemFiles } from "./files";

/**
 * Deletes a proved post's message, then owes the deletes of its images, since Slack keeps a file
 * after the message that showed it is gone. Repeat deletion targets the same post, so retracting
 * again is safe, and it never frees its request or publication key.
 */
export async function retractPost(
  database: BridgeDatabase,
  bot: BotClient,
  linkId: string,
  number: number,
  now = Date.now(),
) {
  const item = await database.read((sql) => readOutboxItem(sql, number));
  if (
    !item ||
    item.linkId !== linkId ||
    item.slackTs === null ||
    !["sent", "delivery_unknown", "retracted"].includes(item.state)
  )
    throw new OutboxRefusedError("This is not a known post belonging to this link.");
  if (item.state === "retracted") return item;
  const installation = await database.read(readInstallation);
  if (installation?.status !== "active") throw new OutboxRefusedError("Slack isn't active.");
  const target = { channelId: item.channelId, ts: item.slackTs };
  const call = await bot.call("chat.delete", (client) =>
    client.chat.delete({
      channel: target.channelId,
      ts: target.ts,
    }),
  );
  const removed =
    (call.kind === "ok" && deleteReceipt(call.result, target)) ||
    (call.kind === "error" && call.error === "message_not_found");
  if (!removed) {
    const problem = call.kind === "error" || call.kind === "auth_failed" ? call.error : call.kind;
    throw new OutboxRefusedError(
      `Deletion is unconfirmed (${problem}). Retrying this same post is safe.`,
    );
  }
  return database.write(async (tx) => {
    await tx`
      UPDATE outbox SET state = 'retracted', next_attempt_at = NULL, updated_at = ${now}
      WHERE id = ${item.id} AND slack_ts = ${item.slackTs} AND state IN ('sent', 'delivery_unknown')
    `;
    await oweItemFiles(tx, item.id, now);
    return readOutboxItem(tx, item.id);
  });
}

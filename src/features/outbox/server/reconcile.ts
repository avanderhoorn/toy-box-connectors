import type { BridgeDatabase } from "@bridge/server/database";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { channelFailureReason } from "@slackapi/model/errors";
import { continueHistory } from "@slackapi/model/history";
import { tsAt } from "@slackapi/model/ts";
import type { BotClient } from "@slackapi/server/botClient";
import { fetchHistoryPage, fetchThreadPage } from "@slackapi/server/history";
import { readInstallation } from "@slackapi/server/installation";
import { ZodError } from "zod";
import { reconciliationReceipt } from "../model/delivery";
import { advanceReconciliation, readOutboxItem, settleOutboxAttempt } from "./database";
import type { PostStep } from "./posts";

/** Two positive-only checks. Pagination stays local; interrupted checks restart without spending a pass. */
export function createReconciliation(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now }: { now?: () => number } = {},
) {
  async function reconcile(id: string): Promise<PostStep> {
    const prepared = await database.read(async (sql) => {
      const item = await readOutboxItem(sql, id);
      if (!item || item.state !== "delivery_unknown") return null;
      const installation = await readInstallation(sql);
      const [link] = await sql<
        { status: string }[]
      >`SELECT status FROM links WHERE id = ${item.linkId}`;
      return { item, installation, active: link?.status === "active" };
    });
    if (!prepared) return { kind: "changed" };
    const { item, installation, active } = prepared;
    if (item.reconcilePass === 2 || item.nextAttemptAt === null)
      return { kind: "waiting", reason: "delivery_unconfirmed" };
    if (!active || installation?.status !== "active")
      return { kind: "waiting", reason: "link_or_installation_inactive" };
    if (item.nextAttemptAt > now()) return { kind: "waiting", reason: "retry_after" };
    const method = item.threadTs === null ? "conversations.history" : "conversations.replies";
    let cursor: string | null = null;
    const used = new Set<string>();
    while (true) {
      let call;
      try {
        call = await bot.call(method, (client) =>
          item.threadTs === null
            ? fetchHistoryPage(client, {
                channelId: item.channelId,
                oldest: tsAt(Math.max(0, item.attemptStartedAt! - 300_000)),
                latest: tsAt(item.attemptStartedAt! + 300_000),
                cursor,
              })
            : fetchThreadPage(client, { channelId: item.channelId, rootTs: item.threadTs, cursor }),
        );
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        return hold("malformed_history", now() + 60_000);
      }
      if (call.kind !== "ok") {
        const reason = call.kind === "error" ? channelFailureReason(call.error) : null;
        if (reason)
          await database.write((tx) => suspendChannelLinks(tx, item.channelId, reason, now()));
        return hold(
          call.kind === "error" || call.kind === "auth_failed" ? call.error : call.kind,
          call.kind === "rate_limited" ? call.until : now() + 60_000,
        );
      }
      for (const message of call.result.messages) {
        const ts = reconciliationReceipt(message, item.channelId, item, installation);
        if (ts === null) continue;
        return database.write(async (tx) => {
          const settled = await settleOutboxAttempt(
            tx,
            item,
            { state: "sent", slackTs: ts },
            now(),
          );
          return settled ? { kind: "settled", item: settled } : { kind: "changed" };
        });
      }
      const next = continueHistory(call.result, used);
      if (next.kind === "incomplete") return hold(next.reason, now() + 60_000);
      if (next.kind === "done") {
        await database.write((tx) => advanceReconciliation(tx, item, null, null, now()));
        return { kind: "waiting", reason: "delivery_unconfirmed" };
      }
      cursor = next.cursor;
      used.add(cursor);
    }
    async function hold(error: string, until: number): Promise<PostStep> {
      await database.write((tx) => advanceReconciliation(tx, item, error, until, now()));
      return { kind: "waiting", reason: error };
    }
  }
  return { reconcile };
}

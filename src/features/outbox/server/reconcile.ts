import { gapOverlapMs } from "@activity/model/gaps";
import type { BridgeDatabase } from "@bridge/server/database";
import { readApproval } from "@links/server/approvals";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { channelFailureReason } from "@slackapi/model/errors";
import { continueHistory, type HistoryPage } from "@slackapi/model/history";
import type { Installation } from "@slackapi/model/installation";
import { slackTsSchema, tsAt, type SlackTs } from "@slackapi/model/ts";
import type { BotClient, SlackCall } from "@slackapi/server/botClient";
import { fetchHistoryPage, fetchThreadPage } from "@slackapi/server/history";
import { readInstallation } from "@slackapi/server/installation";
import { ZodError } from "zod";
import { reconciliationReceipt } from "../model/delivery";
import { advanceReconciliation, readOutboxItem, type OutboxItem } from "./database";
import { linkWasRemoved, purgeRemovedLinkItem, settleDelivery } from "./delivery";
import type { PostStep } from "./posts";

type Preparation =
  | Exclude<PostStep, { kind: "settled" }>
  | { kind: "ready"; item: OutboxItem; identity: Pick<Installation, "appId" | "botId"> };

type ReadScope =
  | { method: "conversations.replies"; rootTs: SlackTs }
  | { method: "conversations.history"; oldest: SlackTs; latest?: SlackTs };

type ReadPass = {
  item: OutboxItem;
  scopes: ReadScope[];
  scopeIndex: number;
  cursor: string | null;
  usedCursors: Set<string>;
};

/** Positive metadata is proof; an unsuccessful pass counts only after all its scopes finish. */
export function createReconciliation(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now }: { now?: () => number } = {},
) {
  const passes = new Map<string, ReadPass>();
  const backoffs = new Map<string, { item: OutboxItem; delay: number }>();
  const running = new Map<string, Promise<PostStep>>();
  let closed = false;

  function reconcile(id: string): Promise<PostStep> {
    const active = running.get(id);
    if (active) return active;
    const pending = run(id).finally(() => running.delete(id));
    running.set(id, pending);
    return pending;
  }

  async function prepare(id: string): Promise<Preparation> {
    if (closed) return { kind: "waiting", reason: "closed", until: null };
    return database.write(async (sql) => {
      const item = await readOutboxItem(sql, id);
      if (!item || item.state !== "delivery_unknown") return { kind: "changed" };
      if (
        (item.reconcilePass === 3 ||
          item.nextAttemptAt === null ||
          channelFailureReason(item.error ?? "") !== null) &&
        (await forgetStoppedOrphan(sql, item, now()))
      ) {
        return { kind: "changed" };
      }
      if (item.reconcilePass === 3) {
        return { kind: "waiting", reason: "reconciliation_stopped", until: null };
      }
      if (channelFailureReason(item.error ?? "") !== null) {
        const linkId = await readOwningLinkId(sql, item);
        const [link] = await sql<{ status: string }[]>`
          SELECT status FROM links WHERE id = ${linkId}
        `;
        if (!link || link.status !== "active") {
          return {
            kind: "waiting",
            reason: linkId === null ? "channel_unavailable" : "link_inactive",
            until: null,
          };
        }
      } else if (item.nextAttemptAt === null) {
        return { kind: "waiting", reason: "reconciliation_stopped", until: null };
      }
      if (item.nextAttemptAt !== null && item.nextAttemptAt > now()) {
        return { kind: "waiting", reason: "retry_after", until: item.nextAttemptAt };
      }
      const installation = await readInstallation(sql);
      if (!installation || installation.status !== "active") {
        return { kind: "waiting", reason: "installation_inactive", until: null };
      }
      if (
        !["reply", "publication", "progress", "card"].includes(item.kind) ||
        (item.attemptMethod !== null &&
          item.attemptMethod !== "chat.postMessage" &&
          item.attemptMethod !== "chat.update")
      ) {
        throw new Error(`Outbox o${item.number} cannot use message reconciliation.`);
      }
      return {
        kind: "ready",
        item,
        identity: { appId: installation.appId, botId: installation.botId },
      };
    });
  }

  async function run(id: string): Promise<PostStep> {
    const prepared = await prepare(id);
    if (prepared.kind !== "ready") {
      if (prepared.kind === "changed" || prepared.reason === "reconciliation_stopped") {
        passes.delete(id);
        backoffs.delete(id);
      }
      return prepared;
    }
    let { item } = prepared;
    const { identity } = prepared;
    if (item.nextAttemptAt === null) {
      const resumed = await resume(item);
      if (!resumed) return { kind: "changed" };
      item = resumed;
    }
    if (item.attemptStartedAt === null) {
      throw new Error(`Outbox o${item.number} has no reconciliation attempt time.`);
    }
    const update =
      item.attemptMethod === "chat.update" || (item.kind === "card" && item.phase === "update");
    const target = update ? slackTsSchema.safeParse(item.payload.ts) : null;
    if (target !== null && !target.success) {
      passes.delete(id);
      return hold(item, "invalid_update_target", null);
    }
    const targetTs = target?.success ? target.data : undefined;
    const oldest = tsAt(Math.max(0, item.attemptStartedAt - gapOverlapMs));
    const scopes: ReadScope[] =
      item.threadTs === null
        ? [
            {
              method: "conversations.history",
              oldest: targetTs ?? oldest,
              ...(targetTs === undefined ? {} : { latest: targetTs }),
            },
          ]
        : [
            { method: "conversations.replies", rootTs: item.threadTs },
            ...(update
              ? []
              : [
                  {
                    method: "conversations.history" as const,
                    oldest,
                  },
                ]),
          ];
    const previous = passes.get(id);
    const pass: ReadPass =
      previous && sameRead(previous.item, item)
        ? previous
        : {
            item,
            scopes,
            scopeIndex: 0,
            cursor: null,
            usedCursors: new Set(),
          };
    passes.set(id, pass);
    while (pass.scopeIndex < pass.scopes.length) {
      const scope = pass.scopes[pass.scopeIndex]!;
      const current = await prepare(id);
      if (current.kind !== "ready") {
        if (current.kind === "changed" || current.reason === "reconciliation_stopped") {
          passes.delete(id);
          backoffs.delete(id);
        }
        return current;
      }
      if (!sameRead(item, current.item)) {
        passes.delete(id);
        backoffs.delete(id);
        return { kind: "changed" };
      }
      let call: SlackCall<HistoryPage>;
      try {
        call = await bot.call(scope.method, (client) =>
          scope.method === "conversations.replies"
            ? fetchThreadPage(client, {
                channelId: item.channelId,
                rootTs: scope.rootTs,
                cursor: pass.cursor,
              })
            : fetchHistoryPage(client, {
                channelId: item.channelId,
                oldest: scope.oldest,
                latest: scope.latest,
                cursor: pass.cursor,
              }),
        );
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        return backoff(item, "malformed_history_page");
      }
      if (call.kind !== "ok") {
        if (
          scope.method === "conversations.replies" &&
          call.kind === "error" &&
          call.error === "thread_not_found"
        ) {
          pass.scopeIndex++;
          pass.cursor = null;
          pass.usedCursors.clear();
          continue;
        }
        if (call.kind === "error") {
          if (call.error === "invalid_cursor") passes.delete(id);
          const reason = channelFailureReason(call.error);
          if (reason !== null) {
            await database.write((tx) => suspendChannelLinks(tx, item.channelId, reason, now()));
            return hold(item, call.error, null);
          }
        }
        const reason =
          call.kind === "unknown"
            ? call.detail
            : call.kind === "rate_limited"
              ? "rate_limited"
              : call.error;
        return call.kind === "rate_limited"
          ? hold(item, reason, call.until)
          : backoff(item, reason);
      }
      for (const message of call.result.messages) {
        const receipt = reconciliationReceipt(
          message,
          item.channelId,
          { ...item, ...(targetTs === undefined ? {} : { ts: targetTs }) },
          identity,
        );
        if (receipt === null) continue;
        passes.delete(id);
        backoffs.delete(id);
        return database.write(async (tx) => {
          const settled = await settleDelivery(
            tx,
            item,
            receipt.kind === "confirmed"
              ? { state: "sent", slackTs: receipt.ts, evidence: "metadata", metadataOk: true }
              : {
                  state: "stray",
                  slackTs: receipt.ts,
                  evidence: "metadata",
                  metadataOk: true,
                  error: "wrong_thread",
                  nextAttemptAt: now(),
                },
            now(),
          );
          return settled ? { kind: "settled", item: settled } : { kind: "changed" };
        });
      }
      const continuation = continueHistory(call.result, pass.usedCursors);
      if (continuation.kind === "incomplete") {
        passes.delete(id);
        return backoff(item, continuation.reason);
      }
      if (continuation.kind === "done") {
        pass.scopeIndex++;
        pass.cursor = null;
        pass.usedCursors.clear();
      } else {
        pass.usedCursors.add(continuation.cursor);
        pass.cursor = continuation.cursor;
      }
    }
    passes.delete(id);
    backoffs.delete(id);
    return database.write(async (tx) => {
      const advanced = await advanceReconciliation(tx, item, now());
      if (advanced?.reconcilePass === 3 && (await forgetStoppedOrphan(tx, advanced, now()))) {
        return { kind: "changed" };
      }
      return advanced ? { kind: "settled", item: advanced } : { kind: "changed" };
    });
  }

  async function resume(item: OutboxItem): Promise<OutboxItem | null> {
    return database.write(async (tx) => {
      const at = now();
      const linkId = await readOwningLinkId(tx, item);
      const changed = await tx`
        UPDATE outbox SET next_attempt_at = ${at}, error = NULL, updated_at = ${at}
        WHERE id = ${item.id} AND state = 'delivery_unknown' AND attempts = ${item.attempts}
          AND payload_hash = ${item.payloadHash} AND reconcile_pass = ${item.reconcilePass}
          AND channel_id = ${item.channelId} AND error IS ${item.error}
          AND next_attempt_at IS NULL
          AND EXISTS (SELECT 1 FROM links WHERE id = ${linkId} AND status = 'active')
        RETURNING id
      `;
      return changed.length > 0 ? readOutboxItem(tx, item.id) : null;
    });
  }

  function backoff(item: OutboxItem, reason: string): Promise<PostStep> {
    const previous = backoffs.get(item.id);
    const delay =
      previous && sameRead(previous.item, item) ? Math.min(previous.delay * 2, 120_000) : 5_000;
    backoffs.set(item.id, { item, delay });
    return hold(item, reason, now() + delay);
  }

  async function hold(item: OutboxItem, reason: string, until: number | null): Promise<PostStep> {
    return database.write(async (tx) => {
      const at = now();
      if (until === null && (await forgetStoppedOrphan(tx, item, at))) {
        return { kind: "changed" };
      }
      const next = until === null ? null : Math.max(until, item.nextAttemptAt ?? 0);
      const changed = await tx`
        UPDATE outbox SET error = ${reason}, next_attempt_at = ${next}, updated_at = ${at}
        WHERE id = ${item.id} AND state = 'delivery_unknown' AND attempts = ${item.attempts}
          AND payload_hash = ${item.payloadHash} AND reconcile_pass = ${item.reconcilePass}
          AND channel_id = ${item.channelId} AND next_attempt_at IS NOT NULL
          AND next_attempt_at <= ${at}
        RETURNING id
      `;
      return changed.length > 0 ? { kind: "waiting", reason, until: next } : { kind: "changed" };
    });
  }

  async function close(): Promise<void> {
    closed = true;
    try {
      await Promise.all(running.values());
    } finally {
      passes.clear();
      backoffs.clear();
    }
  }

  return { reconcile, close };
}

async function forgetStoppedOrphan(tx: Bun.SQL, item: OutboxItem, now: number): Promise<boolean> {
  if (
    !["reply", "progress", "publication", "card"].includes(item.kind) ||
    !(await linkWasRemoved(tx, await readOwningLinkId(tx, item)))
  )
    return false;
  const deleted = await tx`
    DELETE FROM outbox WHERE id = ${item.id} AND state = 'delivery_unknown'
      AND attempts = ${item.attempts} AND payload_hash = ${item.payloadHash}
      AND reconcile_pass = ${item.reconcilePass}
      AND link_id IS ${item.linkId} AND channel_id = ${item.channelId}
      AND thread_ts IS ${item.threadTs}
    RETURNING id
  `;
  if (deleted.length === 0) return false;
  await purgeRemovedLinkItem(tx, item, now);
  return true;
}

async function readOwningLinkId(sql: Bun.SQL, item: OutboxItem): Promise<string | null> {
  const approval =
    item.kind === "card" && item.approvalId !== null
      ? await readApproval(sql, item.approvalId)
      : null;
  return approval?.linkId ?? item.linkId;
}

function sameRead(left: OutboxItem, right: OutboxItem): boolean {
  return (
    left.attempts === right.attempts &&
    left.payloadHash === right.payloadHash &&
    left.reconcilePass === right.reconcilePass &&
    left.channelId === right.channelId &&
    left.threadTs === right.threadTs
  );
}

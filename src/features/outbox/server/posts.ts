import type { BridgeDatabase } from "@bridge/server/database";
import { readApproval, recordCardPosted } from "@links/server/approvals";
import { judgeChannelLinks } from "@links/server/audience";
import { readApprovalCard } from "@links/server/cards";
import { readChannelLink, readChannelUses } from "@links/server/database";
import { suspendLink } from "@links/server/status";
import { isActive } from "@requests/model/lifecycle";
import { readRequest } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import { channelFailureReason } from "@slackapi/model/errors";
import type { Installation } from "@slackapi/model/installation";
import type { BotClient } from "@slackapi/server/botClient";
import {
  fetchChannelFacts,
  invalidateChannelInfo,
  readChannelInfo,
  writeChannelInfo,
} from "@slackapi/server/channels";
import { readInstallation } from "@slackapi/server/installation";
import { ZodError } from "zod";
import {
  nextReconciliation,
  outboxMetadata,
  postReceipt,
  updateReceipt,
  writeOutcome,
  type PostReceipt,
  type WriteOutcome,
} from "../model/delivery";
import { checkCardPayload, checkCardUpdatePayload, checkLeadPayload } from "../model/payload";
import { postingPermission, type PostingLink } from "../model/posting";
import { settleRequestAnswer } from "./answers";
import {
  queueItem,
  readOutboxItem,
  settleOutboxAttempt,
  startOutboxAttempt,
  type OutboxItem,
  type OutboxSettlement,
} from "./database";

export type PostStep =
  | { kind: "settled"; item: OutboxItem }
  | { kind: "waiting"; reason: string; until: number | null }
  | { kind: "changed" };

type Preparation =
  | PostStep
  | { kind: "refresh"; channelId: string }
  | { kind: "started"; item: OutboxItem; identity: Pick<Installation, "appId" | "botId"> };

/**
 * New finals, follow-ups, publications and approval cards, and updates to those cards. Progress,
 * cleanup and feedback have separate handlers. No network call runs inside a write.
 */
export function createPostDelivery(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now }: { now?: () => number } = {},
) {
  async function post(id: string): Promise<PostStep> {
    const cooldown = await bot.cooldown("chat.postMessage");
    if (cooldown !== null) return defer(id, "rate_limited", cooldown);
    let prepared = await database.write((tx) => prepare(tx, id, now()));
    if (prepared.kind === "refresh") {
      const refreshed = await refresh(id, prepared.channelId);
      if (refreshed !== null) return refreshed;
      prepared = await database.write((tx) => prepare(tx, id, now()));
    }
    if (prepared.kind === "refresh") {
      return defer(id, "channel_info_invalidated", now() + 1_000);
    }
    if (prepared.kind !== "started") return prepared;

    const item = prepared.item;
    const identity = prepared.identity;
    const attemptAt = item.attemptStartedAt;
    if (attemptAt === null) throw new Error("A committed post has no attempt time.");
    const payload =
      item.kind === "card" ? checkCardPayload(item.payload) : checkLeadPayload(item.payload);
    if (payload.kind !== "valid") throw new Error("A committed post has an invalid snapshot.");
    const outcome = writeOutcome(
      await bot.call("chat.postMessage", (client) =>
        client.chat.postMessage({
          ...payload.message,
          channel: item.channelId,
          ...(item.threadTs === null ? {} : { thread_ts: item.threadTs, reply_broadcast: false }),
          metadata: outboxMetadata(item),
        }),
      ),
    );
    return finish(
      item,
      outcome.kind === "accepted"
        ? {
            kind: "accepted",
            result: postReceipt(outcome.result, { ...item, text: payload.message.text }, identity),
          }
        : outcome,
      attemptAt,
    );
  }

  async function updateCard(id: string): Promise<PostStep> {
    const cooldown = await bot.cooldown("chat.update");
    if (cooldown !== null) return defer(id, "rate_limited", cooldown);
    const prepared = await database.write((tx) => prepare(tx, id, now(), "chat.update"));
    if (prepared.kind === "refresh")
      throw new Error("An approval card cannot require an audience refresh.");
    if (prepared.kind !== "started") return prepared;
    const item = prepared.item;
    const attemptAt = item.attemptStartedAt;
    if (attemptAt === null) throw new Error("A committed card update has no attempt time.");
    const payload = checkCardUpdatePayload(item.payload);
    if (payload.kind !== "valid")
      throw new Error("A committed card update has an invalid snapshot.");
    const outcome = writeOutcome(
      await bot.call("chat.update", (client) =>
        client.chat.update({
          ...payload.message,
          channel: item.channelId,
          metadata: outboxMetadata(item),
        }),
      ),
    );
    return finish(
      item,
      outcome.kind === "accepted"
        ? {
            kind: "accepted",
            result: updateReceipt(
              outcome.result,
              { ...item, text: payload.message.text, ts: payload.message.ts },
              prepared.identity,
            ),
          }
        : outcome,
      attemptAt,
    );
  }

  async function finish(
    item: OutboxItem,
    outcome: WriteOutcome<PostReceipt>,
    attemptAt: number,
  ): Promise<PostStep> {
    return database.write(async (tx) => {
      const at = now();
      let settlement: OutboxSettlement;
      if (outcome.kind === "accepted") {
        const receipt = outcome.result;
        settlement =
          receipt.kind === "confirmed"
            ? {
                state: "sent",
                slackTs: receipt.ts,
                evidence: "response",
                metadataOk: receipt.metadataOk,
              }
            : receipt.kind === "misplaced"
              ? {
                  state: "stray",
                  slackTs: receipt.ts,
                  evidence: "response",
                  metadataOk: receipt.metadataOk,
                  error: "wrong_thread",
                  nextAttemptAt: at,
                }
              : {
                  state: "delivery_unknown",
                  error: receipt.reason,
                  nextAttemptAt: nextReconciliation(attemptAt, 0),
                };
      } else if (outcome.kind === "delivery_unknown") {
        settlement = {
          state: "delivery_unknown",
          error: outcome.error,
          nextAttemptAt: nextReconciliation(attemptAt, 0),
        };
      } else if (outcome.kind === "queued") {
        settlement = {
          state: "queued",
          error: outcome.error,
          nextAttemptAt: outcome.nextAttemptAt,
        };
      } else {
        settlement = { state: "failed", error: outcome.error };
      }
      const settled = await settleOutboxAttempt(tx, item, settlement, at);
      if (!settled) return { kind: "changed" };
      if (outcome.kind === "failed" && outcome.suspend !== null) {
        await suspendChannel(tx, item.channelId, outcome.suspend, at);
      }
      if (
        settled.state === "sent" &&
        item.kind === "card" &&
        item.phase === "post" &&
        item.approvalId !== null
      ) {
        if (settled.slackTs === null) throw new Error("A confirmed card has no Slack timestamp.");
        await recordCardPosted(tx, item.approvalId, settled.slackTs);
      }
      if (settled.state === "stray") {
        await queueItem(
          tx,
          {
            kind: "retract",
            linkId: settled.linkId,
            requestId: settled.requestId,
            channelId: settled.channelId,
            threadTs: settled.threadTs,
            payload: { target: item.id },
          },
          at,
        );
      }
      if (item.requestId !== null) await settleRequestAnswer(tx, item.requestId, at);
      return { kind: "settled", item: settled };
    });
  }

  async function prepare(
    tx: Bun.SQL,
    id: string,
    at: number,
    method: "chat.postMessage" | "chat.update" = "chat.postMessage",
  ): Promise<Preparation> {
    const item = await readOutboxItem(tx, id);
    if (!item || item.state !== "queued") return { kind: "changed" };
    const supported =
      method === "chat.update"
        ? item.kind === "card" && item.phase === "update"
        : item.kind === "reply" ||
          item.kind === "publication" ||
          (item.kind === "card" && item.phase === "post");
    if (!supported) {
      throw new Error(`Outbox o${item.number} cannot use ${method}.`);
    }
    if (item.nextAttemptAt !== null && item.nextAttemptAt > at) {
      return { kind: "waiting", reason: "retry_after", until: item.nextAttemptAt };
    }
    const installation = await readInstallation(tx);
    if (!installation || installation.status !== "active" || installation.ownerUserId === null) {
      return { kind: "waiting", reason: "installation_inactive", until: null };
    }
    let payload = item.payload;
    if (item.kind === "card") {
      const approval = item.approvalId === null ? null : await readApproval(tx, item.approvalId);
      if (!approval) return finishQueued(tx, item, "dropped", "approval_removed", at);
      if (item.channelId !== approval.card.channelId || item.threadTs !== null) {
        return finishQueued(tx, item, "failed", "destination_changed", at);
      }
      if (method === "chat.postMessage" && approval.card.ts !== null) {
        return finishQueued(tx, item, "dropped", "card_already_posted", at);
      }
      if (method === "chat.update" && approval.card.ts === null) {
        return { kind: "waiting", reason: "card_not_posted", until: null };
      }
      if (method === "chat.update" && approval.state === "pending") {
        return finishQueued(tx, item, "failed", "approval_pending", at);
      }
      const card = await readApprovalCard(tx, approval.id);
      if (!card) throw new Error("An approval disappeared within its transaction.");
      const { text, blocks, parse } = card.message;
      payload =
        method === "chat.update" ? { text, blocks, parse, ts: card.ts } : { ...card.message };
    } else {
      const link = await readPostingLink(tx, item.linkId);
      const request = item.requestId === null ? null : await readRequest(tx, item.requestId);
      const permission = postingPermission(
        item,
        installation,
        link,
        request,
        await readChannelInfo(tx, item.channelId),
        at,
      );
      if (permission.kind === "refresh") return permission;
      if (permission.kind === "superseded") {
        return finishQueued(tx, item, "superseded", "revision_changed", at);
      }
      if (permission.kind === "failed") {
        if (permission.error === "requester_denied" && request && isActive(request.state)) {
          await cancelStoredRequest(tx, request, "requester_denied", at);
          const cancelled = await readOutboxItem(tx, item.id);
          if (!cancelled) return { kind: "changed" };
          return { kind: "settled", item: cancelled };
        }
        return finishQueued(tx, item, "failed", permission.error, at);
      }
      if (permission.kind === "suspended") {
        if (!link) throw new Error("An audience verdict has no link.");
        await suspendLink(tx, link.id, permission.reason, at);
        return { kind: "waiting", reason: permission.reason, until: null };
      }
      if (permission.kind !== "allowed") {
        return { kind: "waiting", reason: permission.reason, until: null };
      }
    }
    const checked =
      method === "chat.update"
        ? checkCardUpdatePayload(payload)
        : item.kind === "card"
          ? checkCardPayload(payload)
          : checkLeadPayload(payload);
    if (checked.kind === "refused") return finishQueued(tx, item, "failed", checked.problem, at);
    const started = await startOutboxAttempt(tx, item, payload, method, at);
    return started.kind === "started"
      ? { ...started, identity: { appId: installation.appId, botId: installation.botId } }
      : started.kind === "waiting"
        ? { ...started, reason: method === "chat.update" ? "card_in_flight" : "post_slot" }
        : started;
  }

  async function refresh(id: string, channelId: string): Promise<PostStep | null> {
    const readAt = now();
    let call;
    try {
      call = await bot.call("conversations.info", (client) => fetchChannelFacts(client, channelId));
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      return defer(id, "malformed_channel_info", now() + 5_000);
    }
    if (call.kind !== "ok") {
      if (call.kind === "error") {
        const reason = channelFailureReason(call.error);
        if (reason !== null) {
          await database.write((tx) => suspendChannel(tx, channelId, reason, now()));
        }
      }
      return defer(
        id,
        call.kind === "unknown"
          ? call.detail
          : call.kind === "rate_limited"
            ? "rate_limited"
            : call.error,
        call.kind === "rate_limited" ? call.until : now() + 5_000,
      );
    }
    const facts = call.result;
    if (facts !== null && facts.id !== channelId) {
      return defer(id, "mismatched_channel_info", now() + 5_000);
    }
    await database.write(async (tx) => {
      if (facts !== null) await writeChannelInfo(tx, facts, readAt);
      await judgeChannelLinks(tx, channelId, facts, now());
    });
    return null;
  }

  async function defer(id: string, reason: string, until: number): Promise<PostStep> {
    return database.write(async (tx) => {
      const item = await readOutboxItem(tx, id);
      if (!item || item.state !== "queued") return { kind: "changed" };
      const next = Math.max(until, item.nextAttemptAt ?? 0);
      await tx`
        UPDATE outbox SET error = ${reason}, next_attempt_at = ${next}, updated_at = ${now()}
        WHERE id = ${id} AND state = 'queued'
      `;
      return { kind: "waiting", reason, until: next };
    });
  }

  return { post, updateCard };
}

async function finishQueued(
  tx: Bun.SQL,
  item: OutboxItem,
  state: "failed" | "dropped" | "superseded",
  error: string,
  now: number,
): Promise<PostStep> {
  await tx`
    UPDATE outbox SET state = ${state}, error = ${error}, next_attempt_at = NULL, updated_at = ${now}
    WHERE id = ${item.id} AND state = 'queued'
  `;
  const settled = await readOutboxItem(tx, item.id);
  if (!settled) return { kind: "changed" };
  if (item.requestId !== null) await settleRequestAnswer(tx, item.requestId, now);
  return { kind: "settled", item: settled };
}

async function readPostingLink(sql: Bun.SQL, id: string | null): Promise<PostingLink | null> {
  if (id === null) return null;
  const [row] = await sql<{ slack_channel_id: string; publish_channel_id: string }[]>`
    SELECT slack_channel_id, publish_channel_id FROM links WHERE id = ${id}
  `;
  if (!row) return null;
  const link = await readChannelLink(sql, row.slack_channel_id);
  const use = (await readChannelUses(sql, row.slack_channel_id)).find(
    (entry) => entry.linkId === id,
  );
  if (!link || link.id !== id || !use) throw new Error("A stored link has no channel or audience.");
  return {
    ...link,
    slackChannelId: row.slack_channel_id,
    publishChannelId: row.publish_channel_id,
    approved: use.approved,
  };
}

async function suspendChannel(
  tx: Bun.SQL,
  channelId: string,
  reason: NonNullable<ReturnType<typeof channelFailureReason>>,
  now: number,
): Promise<void> {
  await invalidateChannelInfo(tx, channelId, now);
  for (const use of await readChannelUses(tx, channelId)) {
    await suspendLink(tx, use.linkId, reason, now);
  }
}

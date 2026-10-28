import type { BridgeDatabase } from "@bridge/server/database";
import { forgetUnlinkedApprovals, readApproval } from "@links/server/approvals";
import { audit } from "@links/server/audit";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { readRequest } from "@requests/server/database";
import { slackTsSchema, type SlackTs } from "@slackapi/model/ts";
import type { BotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { z } from "zod";
import { deleteReceipt, writeOutcome, type WriteOutcome } from "../model/delivery";
import { settleRequestAnswer } from "./answers";
import {
  readOutboxItem,
  settleOutboxAttempt,
  startOutboxAttempt,
  type OutboxItem,
  type OutboxSettlement,
} from "./database";
import {
  cancelThreadRequest,
  deferQueuedDelivery,
  linkWasRemoved,
  settleQueuedDelivery,
} from "./delivery";
import type { PostStep } from "./posts";

const payloadSchema = z
  .object({ target: z.string().min(1), ts: slackTsSchema.optional() })
  .strict();
type Preparation = PostStep | { kind: "started"; item: OutboxItem; target: OutboxItem };

/** Delete only a proved own post. Cleanup may run while its link is suspended. */
export function createRetraction(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now }: { now?: () => number } = {},
) {
  async function retract(id: string): Promise<PostStep> {
    const cooldown = await bot.cooldown("chat.delete");
    const prepared = await database.write((tx) => prepare(tx, id, cooldown, now()));
    if (prepared.kind !== "started") return prepared;
    const { item, target } = prepared;
    const ts = target.slackTs;
    if (ts === null) throw new Error("A committed retraction has no target timestamp.");
    const call = await bot.call("chat.delete", (client) =>
      client.chat.delete({ channel: item.channelId, ts }),
    );
    const outcome = writeOutcome(call);
    return finish(
      item,
      target,
      call.kind === "error" && call.error === "message_not_found"
        ? { kind: "accepted", result: true }
        : outcome.kind === "accepted"
          ? {
              kind: "accepted",
              result: deleteReceipt(outcome.result, { channelId: item.channelId, ts }),
            }
          : outcome,
    );
  }

  async function prepare(
    tx: Bun.SQL,
    id: string,
    cooldown: number | null,
    at: number,
  ): Promise<Preparation> {
    let item = await readOutboxItem(tx, id);
    if (!item || !["queued", "delivery_unknown"].includes(item.state)) return { kind: "changed" };
    if (item.kind !== "retract") throw new Error(`Outbox o${item.number} cannot use chat.delete.`);
    if (item.state === "delivery_unknown") {
      if (item.attemptMethod !== "chat.delete") {
        throw new Error(`Outbox o${item.number} has no interrupted deletion.`);
      }
      item = await settleOutboxAttempt(
        tx,
        item,
        {
          state: "queued",
          error: item.error ?? "interrupted",
          nextAttemptAt: item.nextAttemptAt,
        },
        at,
      );
      if (!item) return { kind: "changed" };
    }
    if (cooldown !== null) {
      const until = await deferQueuedDelivery(tx, item.id, "rate_limited", cooldown, at);
      return until === null
        ? { kind: "changed" }
        : { kind: "waiting", reason: "rate_limited", until };
    }
    const installation = await readInstallation(tx);
    if (!installation || installation.status !== "active") {
      return { kind: "waiting", reason: "installation_inactive", until: null };
    }
    const parsed = payloadSchema.safeParse(item.payload);
    if (!parsed.success || (item.attempts > 0 && parsed.data.ts === undefined)) {
      return refuse(tx, item, "failed", "invalid_retract_payload", at);
    }
    const target = await readOutboxItem(tx, parsed.data.target);
    if (!target) return refuse(tx, item, "dropped", "target_missing", at);
    if (!sameTarget(item, target, parsed.data.ts)) {
      return refuse(tx, item, "failed", "target_mismatch", at);
    }
    if (
      target.state === "retracted" ||
      (target.state === "failed" && target.error === "misplaced_reply_withdrawn")
    ) {
      return refuse(tx, item, "dropped", "already_withdrawn", at);
    }
    if (!canRetract(target)) {
      return refuse(tx, item, "failed", "target_unconfirmed", at);
    }
    const snapshot = item.attempts > 0 ? item.payload : { ...item.payload, ts: target.slackTs };
    const started = await startOutboxAttempt(tx, item, snapshot, "chat.delete", at);
    return started.kind === "started" ? { ...started, target } : started;
  }

  async function finish(
    item: OutboxItem,
    target: OutboxItem,
    outcome: WriteOutcome<boolean>,
  ): Promise<PostStep> {
    return database.write(async (tx) => {
      const at = now();
      const settlement: OutboxSettlement =
        outcome.kind === "accepted" && outcome.result
          ? { state: "sent", slackTs: target.slackTs, evidence: "response", metadataOk: null }
          : outcome.kind === "failed"
            ? { state: "failed", error: outcome.error }
            : {
                state: "queued",
                error: outcome.kind === "accepted" ? "invalid_delete_response" : outcome.error,
                nextAttemptAt:
                  outcome.kind === "queued"
                    ? outcome.nextAttemptAt
                    : at + Math.min(5_000 * 2 ** (item.attempts - 1), 120_000),
              };
      const settled = await settleOutboxAttempt(tx, item, settlement, at);
      if (!settled) return { kind: "changed" };
      if (outcome.kind === "failed" && outcome.suspend !== null) {
        await suspendChannelLinks(tx, item.channelId, outcome.suspend, at);
      }
      if (settled.state === "sent") {
        const changed = await tx`
          UPDATE outbox SET state = CASE WHEN state = 'stray' THEN 'failed' ELSE 'retracted' END,
            error = CASE WHEN state = 'stray' THEN 'misplaced_reply_withdrawn' ELSE error END,
            next_attempt_at = NULL, updated_at = ${at}
          WHERE id = ${target.id} AND state IN ('sent', 'stray') AND slack_ts = ${target.slackTs}
            AND link_id IS ${target.linkId} AND channel_id = ${target.channelId}
            AND request_id IS ${target.requestId} AND thread_ts IS ${target.threadTs}
            AND attempts = ${target.attempts} AND payload_hash = ${target.payloadHash}
          RETURNING request_id
        `;
        if (changed.length > 0 && target.state === "stray") {
          await cancelThreadRequest(tx, target, at);
        }
        if (
          changed.length > 0 &&
          target.kind === "reply" &&
          target.phase === "final" &&
          target.requestId !== null
        ) {
          const request = await readRequest(tx, target.requestId);
          if (
            request?.linkId === target.linkId &&
            request.channelId === target.channelId &&
            request.rootTs === target.threadTs
          ) {
            await settleRequestAnswer(tx, target.requestId, at);
          }
        }
        if (changed.length > 0 && (await orphanedTarget(tx, target))) {
          await tx`DELETE FROM outbox WHERE id IN (${item.id}, ${target.id})`;
        }
      } else if (settled.state === "failed") {
        if (target.state === "stray") {
          await tx`
            UPDATE outbox SET error = ${settled.error}, updated_at = ${at}
            WHERE id = ${target.id} AND state = 'stray' AND slack_ts = ${target.slackTs}
              AND link_id IS ${target.linkId} AND channel_id = ${target.channelId}
              AND request_id IS ${target.requestId} AND thread_ts IS ${target.threadTs}
              AND attempts = ${target.attempts} AND payload_hash = ${target.payloadHash}
          `;
        }
        await abandonOrphan(tx, item, target, at);
        if (await orphanedTarget(tx, target)) {
          await tx`DELETE FROM outbox WHERE id = ${item.id}`;
        }
      }
      await forgetUnlinkedApprovals(tx, at);
      return { kind: "settled", item: settled };
    });
  }

  return { retract };
}

async function refuse(
  tx: Bun.SQL,
  item: OutboxItem,
  state: "failed" | "dropped",
  error: string,
  now: number,
): Promise<PostStep> {
  const settled = await settleQueuedDelivery(tx, item, state, error, now);
  if (settled) {
    const parsed = payloadSchema.safeParse({
      target: item.payload.target,
      ...(item.payload.ts === undefined ? {} : { ts: item.payload.ts }),
    });
    const target = parsed.success ? await readOutboxItem(tx, parsed.data.target) : null;
    if (
      parsed.success &&
      target &&
      sameTarget(item, target, parsed.data.ts) &&
      canRetract(target)
    ) {
      await abandonOrphan(tx, item, target, now);
    } else if (await linkWasRemoved(tx, item.linkId)) {
      await tx`DELETE FROM outbox WHERE id = ${item.id}`;
    }
    await forgetUnlinkedApprovals(tx, now);
  }
  return settled ? { kind: "settled", item: settled } : { kind: "changed" };
}

function sameTarget(item: OutboxItem, target: OutboxItem, ts?: SlackTs): boolean {
  return (
    target.channelId === item.channelId &&
    target.linkId === item.linkId &&
    target.requestId === item.requestId &&
    target.threadTs === item.threadTs &&
    (ts === undefined || ts === target.slackTs)
  );
}

function canRetract(target: OutboxItem): boolean {
  return (
    ["reply", "progress", "publication", "card"].includes(target.kind) &&
    ["sent", "stray"].includes(target.state) &&
    target.slackTs !== null &&
    target.evidence !== null &&
    (target.kind !== "card" || (target.state === "stray" && target.phase === "post"))
  );
}

async function orphanedTarget(tx: Bun.SQL, target: OutboxItem): Promise<boolean> {
  return target.kind === "card"
    ? target.approvalId === null || (await readApproval(tx, target.approvalId)) === null
    : linkWasRemoved(tx, target.linkId);
}

async function abandonOrphan(
  tx: Bun.SQL,
  item: OutboxItem,
  target: OutboxItem,
  now: number,
): Promise<void> {
  const current = await readOutboxItem(tx, target.id);
  if (
    !current ||
    current.state !== target.state ||
    current.slackTs !== target.slackTs ||
    current.attempts !== target.attempts ||
    current.payloadHash !== target.payloadHash ||
    !sameTarget(item, current) ||
    !canRetract(current) ||
    !(await orphanedTarget(tx, current))
  ) {
    return;
  }
  await audit(
    tx,
    {
      actor: "bridge",
      action: "abandon_post",
      linkId: target.linkId,
      approvalId: target.approvalId,
      subject: `${target.channelId}/${target.slackTs}`,
    },
    now,
  );
  await tx`DELETE FROM outbox WHERE id IN (${item.id}, ${target.id})`;
}

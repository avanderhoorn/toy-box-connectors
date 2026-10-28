import type { BridgeDatabase } from "@bridge/server/database";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { isActive } from "@requests/model/lifecycle";
import { readRequest } from "@requests/server/database";
import { channelFailureReason } from "@slackapi/model/errors";
import { slackTsSchema } from "@slackapi/model/ts";
import type { BotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { z } from "zod";
import { writeOutcome, type OutboxMethod } from "../model/delivery";
import {
  queueReaction,
  readOutboxItem,
  settleOutboxAttempt,
  startOutboxAttempt,
  type OutboxItem,
  type OutboxSettlement,
} from "./database";
import { deferQueuedDelivery, linkWasRemoved, settleQueuedDelivery } from "./delivery";
import type { PostStep } from "./posts";

const payloadSchema = z
  .object({
    action: z.enum(["add", "remove"]),
    name: z.string().min(1),
    timestamp: slackTsSchema,
  })
  .strict();
const receiptSchema = z.object({ ok: z.literal(true) });
type Reaction = z.output<typeof payloadSchema>;
type ReactionMethod = Extract<OutboxMethod, "reactions.add" | "reactions.remove">;
type Preparation =
  | PostStep
  | { kind: "started"; item: OutboxItem; reaction: Reaction; uncertain: boolean };
type Permission =
  | { kind: "allowed" }
  | { kind: "waiting"; reason: string; until: null }
  | { kind: "refused"; state: "dropped" | "failed"; error: string };

/** Reactions are idempotent feedback. They never settle or hold an answer. */
export function createReactionDelivery(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now }: { now?: () => number } = {},
) {
  async function react(id: string): Promise<PostStep> {
    const [add, remove] = await Promise.all([
      bot.cooldown("reactions.add"),
      bot.cooldown("reactions.remove"),
    ]);
    const prepared = await database.write((tx) =>
      prepare(tx, id, { "reactions.add": add, "reactions.remove": remove }, now()),
    );
    if (prepared.kind !== "started") return prepared;
    const { item, reaction, uncertain } = prepared;
    const method = reaction.action === "add" ? "reactions.add" : "reactions.remove";
    const { name, timestamp } = reaction;
    const call = await bot.call(method, (client) =>
      reaction.action === "add"
        ? client.reactions.add({ channel: item.channelId, name, timestamp })
        : client.reactions.remove({ channel: item.channelId, name, timestamp }),
    );
    const outcome = writeOutcome(call);
    const complete =
      (call.kind === "error" &&
        (call.error === "message_not_found" ||
          (reaction.action === "add" && call.error === "already_reacted") ||
          (reaction.action === "remove" && call.error === "no_reaction"))) ||
      (outcome.kind === "accepted" && receiptSchema.safeParse(outcome.result).success);
    return database.write(async (tx) => {
      const at = now();
      const channelRefusal = outcome.kind === "failed" && outcome.suspend !== null;
      const settlement: OutboxSettlement = complete
        ? {
            state: "sent",
            slackTs: timestamp,
            evidence: "response",
            metadataOk: null,
          }
        : outcome.kind === "failed" && (!channelRefusal || item.linkId === null)
          ? { state: "failed", error: outcome.error }
          : {
              state:
                outcome.kind === "accepted" || outcome.kind === "delivery_unknown" || uncertain
                  ? "delivery_unknown"
                  : "queued",
              error: outcome.kind === "accepted" ? "invalid_reaction_response" : outcome.error,
              nextAttemptAt: channelRefusal
                ? null
                : outcome.kind === "queued"
                  ? outcome.nextAttemptAt
                  : at + Math.min(5_000 * 2 ** (item.attempts - 1), 120_000),
            };
      const settled = await settleOutboxAttempt(tx, item, settlement, at);
      if (!settled) return { kind: "changed" };
      if (outcome.kind === "failed" && outcome.suspend !== null) {
        await suspendChannelLinks(tx, item.channelId, outcome.suspend, at);
      }
      if (reaction.action === "add") {
        const permission = await additionPermission(tx, item, reaction);
        if (permission.kind === "refused") {
          if (
            !channelRefusal &&
            (outcome.kind === "accepted" ||
              outcome.kind === "delivery_unknown" ||
              item.attempts > 1)
          ) {
            await compensate(tx, item, reaction, at);
          }
          if (settled.state === "queued" || settled.state === "delivery_unknown") {
            return refuse(tx, settled, permission.state, permission.error, at);
          }
        }
      }
      if (
        (settled.state === "queued" || settled.state === "delivery_unknown") &&
        channelRefusal &&
        (await linkWasRemoved(tx, item.linkId))
      ) {
        return refuse(tx, settled, "dropped", outcome.error, at);
      }
      await forgetSettledOrphan(tx, settled);
      return { kind: "settled", item: settled };
    });
  }

  async function prepare(
    tx: Bun.SQL,
    id: string,
    cooldowns: Record<ReactionMethod, number | null>,
    at: number,
  ): Promise<Preparation> {
    let item = await readOutboxItem(tx, id);
    if (!item || !["queued", "delivery_unknown"].includes(item.state)) return { kind: "changed" };
    if (item.kind !== "reaction") throw new Error(`Outbox o${item.number} is not a reaction.`);
    if (item.state === "delivery_unknown") {
      if (item.attemptMethod !== "reactions.add" && item.attemptMethod !== "reactions.remove") {
        throw new Error(`Outbox o${item.number} has no interrupted reaction.`);
      }
    }
    const parsed = payloadSchema.safeParse(item.payload);
    if (!parsed.success) return refuse(tx, item, "failed", "invalid_reaction_payload", at);
    const reaction = parsed.data;
    const method = reaction.action === "add" ? "reactions.add" : "reactions.remove";
    if (item.attempts > 0 && item.attemptMethod !== method) {
      return refuse(tx, item, "failed", "reaction_method_changed", at);
    }
    if (
      item.error !== null &&
      channelFailureReason(item.error) !== null &&
      (await linkWasRemoved(tx, item.linkId))
    ) {
      return refuse(tx, item, "dropped", item.error, at);
    }
    if (reaction.action === "add") {
      const permission = await additionPermission(tx, item, reaction);
      if (permission.kind === "refused") {
        if (item.attempts > 0) await compensate(tx, item, reaction, at);
        return refuse(tx, item, permission.state, permission.error, at);
      }
      if (permission.kind === "waiting") return permission;
    }
    if (item.error !== null && channelFailureReason(item.error) !== null) {
      const [link] = await tx<
        { status: string }[]
      >`SELECT status FROM links WHERE id = ${item.linkId}`;
      if (!link || link.status !== "active") {
        return { kind: "waiting", reason: "channel_unavailable", until: null };
      }
    }
    const installation = await readInstallation(tx);
    if (!installation || installation.status !== "active") {
      return { kind: "waiting", reason: "installation_inactive", until: null };
    }
    const cooldown = cooldowns[method];
    if (cooldown !== null) {
      if (item.state === "delivery_unknown") {
        const until = Math.max(cooldown, item.nextAttemptAt ?? 0);
        const changed = await settleOutboxAttempt(
          tx,
          item,
          { state: "delivery_unknown", error: "rate_limited", nextAttemptAt: until },
          at,
        );
        return changed ? { kind: "waiting", reason: "rate_limited", until } : { kind: "changed" };
      }
      const until = await deferQueuedDelivery(tx, item.id, "rate_limited", cooldown, at);
      return until === null
        ? { kind: "changed" }
        : { kind: "waiting", reason: "rate_limited", until };
    }
    if (item.nextAttemptAt !== null && item.nextAttemptAt > at) {
      return { kind: "waiting", reason: "retry_after", until: item.nextAttemptAt };
    }
    const [sending] = await tx`
      SELECT id FROM outbox WHERE kind = 'reaction' AND state = 'sending'
        AND channel_id = ${item.channelId} AND id <> ${item.id}
        AND json_extract(payload, '$.name') = ${reaction.name}
        AND json_extract(payload, '$.timestamp') = ${reaction.timestamp}
      LIMIT 1
    `;
    if (sending) return { kind: "waiting", reason: "reaction_in_flight", until: at + 1_000 };
    const uncertain = item.state === "delivery_unknown";
    if (uncertain) {
      item = await settleOutboxAttempt(
        tx,
        item,
        { state: "queued", error: item.error ?? "interrupted", nextAttemptAt: item.nextAttemptAt },
        at,
      );
      if (!item) return { kind: "changed" };
    }
    const started = await startOutboxAttempt(tx, item, item.payload, method, at);
    return started.kind === "started" ? { ...started, reaction, uncertain } : started;
  }

  return { react };
}

async function additionPermission(
  tx: Bun.SQL,
  item: OutboxItem,
  reaction: Reaction,
): Promise<Permission> {
  if (item.linkId === null) {
    return item.requestId === null && reaction.name !== "eyes"
      ? { kind: "allowed" }
      : { kind: "refused", state: "failed", error: "reaction_request_missing" };
  }
  const [link] = await tx<{ status: string; slack_channel_id: string }[]>`
    SELECT status, slack_channel_id FROM links WHERE id = ${item.linkId}
  `;
  if (!link) return { kind: "refused", state: "dropped", error: "link_removed" };
  if (link.slack_channel_id !== item.channelId) {
    return { kind: "refused", state: "failed", error: "reaction_target_mismatch" };
  }
  const request = item.requestId === null ? null : await readRequest(tx, item.requestId);
  if (item.requestId !== null) {
    if (!request) return { kind: "refused", state: "dropped", error: "request_missing" };
    if (
      request.linkId !== item.linkId ||
      request.channelId !== item.channelId ||
      request.sourceTs !== reaction.timestamp
    ) {
      return { kind: "refused", state: "failed", error: "reaction_target_mismatch" };
    }
  }
  if (
    reaction.name === "eyes" &&
    (!request || !isActive(request.state) || request.seenAt === null)
  ) {
    return { kind: "refused", state: "dropped", error: "reaction_no_longer_needed" };
  }
  if (
    reaction.name === "white_check_mark" &&
    item.requestId !== null &&
    request?.state !== "answered"
  ) {
    return { kind: "refused", state: "dropped", error: "reaction_answer_unconfirmed" };
  }
  if (
    link.status !== "active" &&
    !(reaction.name === "white_check_mark" && request?.state === "answered")
  ) {
    return { kind: "waiting", reason: "link_inactive", until: null };
  }
  return { kind: "allowed" };
}

async function compensate(
  tx: Bun.SQL,
  item: OutboxItem,
  reaction: Reaction,
  now: number,
): Promise<void> {
  await queueReaction(
    tx,
    {
      action: "remove",
      name: reaction.name,
      channelId: item.channelId,
      ts: reaction.timestamp,
      linkId: item.linkId,
      requestId: item.requestId,
    },
    now,
  );
}

async function refuse(
  tx: Bun.SQL,
  item: OutboxItem,
  state: "dropped" | "failed",
  error: string,
  now: number,
): Promise<PostStep> {
  const queued =
    item.state === "delivery_unknown"
      ? await settleOutboxAttempt(
          tx,
          item,
          { state: "queued", error, nextAttemptAt: item.nextAttemptAt },
          now,
        )
      : item;
  if (!queued) return { kind: "changed" };
  const settled = await settleQueuedDelivery(tx, queued, state, error, now);
  if (!settled) return { kind: "changed" };
  await forgetSettledOrphan(tx, settled);
  return { kind: "settled", item: settled };
}

async function forgetSettledOrphan(tx: Bun.SQL, item: OutboxItem): Promise<void> {
  if (
    !["queued", "sending", "delivery_unknown"].includes(item.state) &&
    (await linkWasRemoved(tx, item.linkId))
  ) {
    await tx`DELETE FROM outbox WHERE id = ${item.id}`;
  }
}

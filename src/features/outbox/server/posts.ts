import type { BridgeDatabase } from "@bridge/server/database";
import { judgeChannelLink } from "@links/server/audience";
import { readChannelLink } from "@links/server/database";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { readRequest } from "@requests/server/database";
import { channelFailureReason } from "@slackapi/model/errors";
import type { Installation } from "@slackapi/model/installation";
import type { BotClient, SlackCall } from "@slackapi/server/botClient";
import { fetchChannelFacts } from "@slackapi/server/channels";
import { readInstallation } from "@slackapi/server/installation";
import { canonicalUserId } from "@slackapi/server/users";
import { ZodError } from "zod";
import { outboxMetadata, postSettlement } from "../model/delivery";
import { checkLeadPayload } from "../model/payload";
import type { RenderedMessage } from "../model/rendering";
import {
  failQueuedItem,
  readOutboxItem,
  settleOutboxAttempt,
  startOutboxAttempt,
  type OutboxItem,
} from "./database";

export type PostStep =
  | { kind: "settled"; item: OutboxItem }
  | { kind: "waiting"; reason: string }
  | { kind: "changed" };
type Prepared =
  | PostStep
  | {
      kind: "started";
      item: OutboxItem;
      identity: Pick<Installation, "appId" | "botId">;
      message: RenderedMessage;
    };

export function createPostDelivery(
  database: BridgeDatabase,
  bot: BotClient,
  { now = Date.now }: { now?: () => number } = {},
) {
  async function post(id: string): Promise<PostStep> {
    const queued = await database.read((sql) => readOutboxItem(sql, id));
    if (!queued || queued.state !== "queued") return { kind: "changed" };
    if (queued.nextAttemptAt !== null && queued.nextAttemptAt > now())
      return { kind: "waiting", reason: "retry_after" };
    let facts: SlackCall<Awaited<ReturnType<typeof fetchChannelFacts>>>;
    try {
      facts = await bot.call("conversations.info", (client) =>
        fetchChannelFacts(client, queued.channelId),
      );
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      return defer(queued, "invalid_channel_facts", now() + 30_000);
    }
    if (facts.kind !== "ok") {
      const reason = facts.kind === "error" ? channelFailureReason(facts.error) : null;
      if (reason)
        await database.write((tx) => suspendChannelLinks(tx, queued.channelId, reason, now()));
      return defer(
        queued,
        facts.kind === "error" || facts.kind === "auth_failed" ? facts.error : facts.kind,
        facts.kind === "rate_limited" ? facts.until : now() + 30_000,
      );
    }
    const prepared = await database.write(async (tx): Promise<Prepared> => {
      const verdict = await judgeChannelLink(
        tx,
        queued.channelId,
        facts.result?.id === queued.channelId ? facts.result : null,
        now(),
      );
      if (verdict?.kind !== "approved") return { kind: "waiting", reason: "channel_not_approved" };
      return prepare(tx, id, now());
    });
    if (prepared.kind !== "started") return prepared;
    const { item, identity, message } = prepared;
    const settlement = postSettlement(
      await bot.call("chat.postMessage", (client) =>
        client.chat.postMessage({
          ...message,
          channel: item.channelId,
          metadata: outboxMetadata(item),
          ...(item.threadTs === null ? {} : { thread_ts: item.threadTs, reply_broadcast: false }),
        }),
      ),
      item,
      identity,
    );
    const suspend = settlement.state === "failed" ? channelFailureReason(settlement.error) : null;
    return database.write(async (tx) => {
      const settled = await settleOutboxAttempt(tx, item, settlement, now());
      if (settled && suspend) await suspendChannelLinks(tx, item.channelId, suspend, now());
      return settled ? { kind: "settled", item: settled } : { kind: "changed" };
    });
  }

  async function prepare(tx: Bun.SQL, id: string, at: number): Promise<Prepared> {
    const item = await readOutboxItem(tx, id);
    if (!item || item.state !== "queued") return { kind: "changed" };
    const installation = await readInstallation(tx);
    if (!installation || installation.status !== "active")
      return { kind: "waiting", reason: "installation_inactive" };
    const link = await readChannelLink(tx, item.channelId);
    if (!link || link.id !== item.linkId) return refuse(tx, item, "destination_changed", at);
    if (link.status !== "active") return { kind: "waiting", reason: "link_inactive" };
    if (item.kind === "reply") {
      const request = await readRequest(tx, item.requestId!);
      if (
        !request ||
        request.state !== "answering" ||
        request.linkId !== item.linkId ||
        request.channelId !== item.channelId ||
        request.rootTs !== item.threadTs
      )
        return refuse(tx, item, "request_no_longer_valid", at);
      if (!link.allowlist.has(await canonicalUserId(tx, request.requesterUserId)))
        return refuse(tx, item, "requester_not_allowed", at);
    }
    const payload = checkLeadPayload(item.payload);
    if (payload.kind !== "valid") return refuse(tx, item, payload.problem, at);
    const started = await startOutboxAttempt(tx, item, at);
    return started
      ? { kind: "started", item: started, identity: installation, message: payload.message }
      : { kind: "changed" };
  }

  async function refuse(
    tx: Bun.SQL,
    item: OutboxItem,
    reason: string,
    at: number,
  ): Promise<PostStep> {
    const settled = await failQueuedItem(tx, item, reason, at);
    return settled ? { kind: "settled", item: settled } : { kind: "changed" };
  }
  async function defer(item: OutboxItem, reason: string, until: number): Promise<PostStep> {
    await database.write(async (tx) => {
      await tx`
        UPDATE outbox SET error = ${reason}, next_attempt_at = MAX(COALESCE(next_attempt_at, 0), ${until}),
          updated_at = ${now()} WHERE id = ${item.id} AND state = 'queued' AND attempts = ${item.attempts}
      `;
    });
    return { kind: "waiting", reason };
  }
  return { post };
}

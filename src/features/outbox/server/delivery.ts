import type { ChannelSuspendReason } from "@links/model/audience";
import { recordCardPosted } from "@links/server/approvals";
import { suspendChannelLinks } from "@links/server/lifecycle";
import { settleRequestAnswer } from "./answers";
import { queueItem, settleOutboxAttempt, type OutboxItem, type OutboxSettlement } from "./database";

/** A response and a metadata read commit the same proof, cleanup and request effects. */
export async function settleDelivery(
  tx: Bun.SQL,
  item: OutboxItem,
  outcome: OutboxSettlement,
  now: number,
  suspend: ChannelSuspendReason | null = null,
): Promise<OutboxItem | null> {
  const settled = await settleOutboxAttempt(tx, item, outcome, now);
  if (!settled) return null;
  if (suspend !== null) await suspendChannelLinks(tx, item.channelId, suspend, now);
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
        payload: { target: settled.id },
      },
      now,
    );
  }
  if (item.requestId !== null) await settleRequestAnswer(tx, item.requestId, now);
  return settled;
}

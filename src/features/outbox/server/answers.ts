import { confirmAnswer, returnToSeen } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { queueReaction, type OutboxState } from "./database";

/**
 * Settles an answering request by its final reply: a reply Slack confirmed answers it, and one
 * Slack refused gives it back to the lead. Proof calls this after storing the outcome, inside the
 * transaction that stored it.
 */
export async function settleRequestAnswer(
  transaction: Bun.SQL,
  requestId: number,
  now: number,
): Promise<boolean> {
  const request = await readRequest(transaction, requestId);
  if (!request || request.state !== "answering") return false;
  const finals = await transaction<{ state: OutboxState }[]>`
    SELECT state FROM outbox
    WHERE request_id = ${requestId} AND kind = 'reply' AND phase = 'final'
  `;
  if (finals.some((reply) => reply.state === "sent" || reply.state === "retracted")) {
    await saveRequest(transaction, confirmAnswer(request));
    await queueReaction(
      transaction,
      {
        action: "add",
        name: "white_check_mark",
        channelId: request.channelId,
        ts: request.sourceTs,
        linkId: request.linkId,
        requestId,
      },
      now,
    );
    return true;
  }
  if (
    finals.some((reply) => ["queued", "sending", "delivery_unknown", "stray"].includes(reply.state))
  ) {
    return false;
  }
  if (finals.some((reply) => ["failed", "dropped", "cancelled"].includes(reply.state))) {
    await saveRequest(transaction, returnToSeen(request, now));
    return true;
  }
  return false;
}

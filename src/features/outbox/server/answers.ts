import { confirmAnswer, returnToProgress } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { queueReaction, type OutboxState } from "./database";

type FinalReply = { request_rev: number; state: OutboxState };

/**
 * Settles delivery proof and verified input together. Proof calls this after storing sent, and
 * repair calls it after changing a request, all inside the transaction that made the change.
 */
export async function settleRequestAnswer(
  transaction: Bun.SQL,
  requestId: number,
  now: number,
): Promise<boolean> {
  const request = await readRequest(transaction, requestId);
  if (!request || request.state !== "answering") return false;
  await transaction`
    UPDATE outbox SET state = 'superseded', updated_at = ${now}
    WHERE request_id = ${requestId} AND kind = 'reply' AND phase = 'final'
      AND state = 'queued' AND request_rev < ${request.inputRev}
  `;
  const finals = await transaction<FinalReply[]>`
    SELECT request_rev, state FROM outbox
    WHERE request_id = ${requestId} AND kind = 'reply' AND phase = 'final'
  `;
  const current = finals.filter((reply) => reply.request_rev === request.inputRev);
  if (current.some((reply) => reply.state === "sent" || reply.state === "retracted")) {
    if (request.sourceUnverifiedAt !== null) return false;
    await saveRequest(transaction, confirmAnswer(request, request.inputRev, now));
    for (const [action, name] of [
      ["remove", "eyes"],
      ["add", "white_check_mark"],
    ] as const) {
      await queueReaction(
        transaction,
        {
          action,
          name,
          channelId: request.channelId,
          ts: request.sourceTs,
          linkId: request.linkId,
          requestId,
        },
        now,
      );
    }
    return true;
  }
  if (
    current.some((reply) =>
      ["queued", "sending", "delivery_unknown", "stray"].includes(reply.state),
    )
  ) {
    return false;
  }
  if (current.some((reply) => ["failed", "dropped", "cancelled"].includes(reply.state))) {
    await saveRequest(transaction, returnToProgress(request, "reply_failed", now));
    return true;
  }
  if (finals.some((reply) => reply.request_rev < request.inputRev)) {
    await saveRequest(
      transaction,
      returnToProgress(
        request,
        request.attention === "reply_failed" ? "reply_failed" : "updated",
        now,
      ),
    );
    return true;
  }
  return false;
}

import { cardPeople, renderCard, type CardMessage } from "@links/model/cards";
import type { SlackTs } from "@slackapi/model/ts";
import { readSlackPersonName } from "@slackapi/server/users";
import { readApproval } from "./approvals";

/** Where an approval's card is posted, and how it looks now. */
export type ApprovalCard = {
  channelId: string;
  /** Null until recordCardPosted stores the ts Slack gave the post. */
  ts: SlackTs | null;
  message: CardMessage;
};

/**
 * The card for `approvalId` as the approval is now, which the outbox reads each time it posts or
 * updates it, naming people by what the bridge stored about them. Null once the approval is gone,
 * such as purged by unlink or uninstall, so the outbox drops the item.
 */
export async function readApprovalCard(
  sql: Bun.SQL,
  approvalId: string,
): Promise<ApprovalCard | null> {
  const approval = await readApproval(sql, approvalId);
  if (!approval) return null;
  const names: Record<string, string | null> = {};
  for (const userId of cardPeople(approval)) {
    names[userId] = await readSlackPersonName(sql, userId);
  }
  return {
    channelId: approval.card.channelId,
    ts: approval.card.ts,
    message: renderCard(approval, names),
  };
}

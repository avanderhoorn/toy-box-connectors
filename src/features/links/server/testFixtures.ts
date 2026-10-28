import type { BridgeDatabase } from "@bridge/server/database";
import type { Approval } from "@links/model/approvals";
import type { ApprovedAudience } from "@links/model/audience";
import { pendingApproval, privateAudience } from "@links/model/testFixtures";
import { approvalColumns } from "./approvals";

/**
 * Persist an active Link fixture so rows that belong to a Link can be stored. It watches and
 * publishes to C-{id}, which the owner approved as a private channel of T-home. `columns` replace
 * the fixture's, such as its settings or a Toy Box channel and routine a fake serves.
 */
export function createStoredLink(
  database: BridgeDatabase,
  id = "link",
  columns: {
    toybox_channel_id?: string;
    slack_channel_id?: string;
    publish_channel_id?: string;
    requests_routine_id?: string;
    status?: "active" | "paused" | "suspended";
    status_reason?: string | null;
    request_mode?: "mention" | "all";
    observe?: "requesters" | "channel";
    approved_audience?: ApprovedAudience;
  } = {},
) {
  const { approved_audience: approved, ...rest } = columns;
  const slackChannelId = rest.slack_channel_id ?? `C-${id}`;
  const publishChannelId = rest.publish_channel_id ?? slackChannelId;
  const link = {
    id,
    toybox_channel_id: `toybox-${id}`,
    slack_channel_id: slackChannelId,
    publish_channel_id: publishChannelId,
    status: "active",
    approved_audience: JSON.stringify(
      approved ?? {
        monitored: privateAudience(slackChannelId),
        publish: privateAudience(publishChannelId),
      },
    ),
    requests_routine_id: `routine-${id}`,
    routine_state: "present",
    linked_at_ts: "1700000000.000100",
    created_at: 0,
    updated_at: 0,
    ...rest,
  };
  return database.write((transaction) => transaction`INSERT INTO links ${transaction(link)}`);
}

/**
 * Persist a pending proposal to allow U-carol on `link`, asked of U-owner, whose card is posted in
 * C-link at 1000.000100. `changes` replace its fields.
 */
export async function createStoredApproval(
  database: BridgeDatabase,
  changes: Partial<Approval> = {},
): Promise<Approval> {
  const approval = pendingApproval(changes);
  await database.write(
    (transaction) => transaction`INSERT INTO approvals ${transaction(approvalColumns(approval))}`,
  );
  return approval;
}

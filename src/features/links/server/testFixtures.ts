import type { BridgeDatabase } from "@bridge/server/database";
import type { Approval } from "@links/model/approvals";
import type { ApprovedAudience } from "@links/model/audience";
import { pendingApproval, privateAudience } from "@links/model/testFixtures";
import type { ChannelFacts } from "@slackapi/model/channels";
import type { SlackPerson } from "@slackapi/model/users";
import type { ToyBoxChannelView } from "@toybox/model/stream";
import { approvalColumns } from "./approvals";
import type { FactsReader, Unverified } from "./facts";

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

/** What Slack and Toy Box say to a fake FactsReader. A test changes it to change what the next read finds. */
export type FactsWorld = {
  toyBox: ToyBoxChannelView | null | Unverified;
  /** Set when Slack can't be read. */
  slack: Unverified | null;
  channels: Record<string, ChannelFacts>;
  members: Record<string, readonly string[]>;
  people: Record<string, SlackPerson>;
};

/** A requests routine `id` that runs inbox, as Toy Box lists it. */
export function requestsRoutine(id: string) {
  return {
    id,
    title: "Slack requests",
    schedule: "*/5 * * * *",
    prompt: "Run toy-box-slack inbox.",
  };
}

/**
 * A reader that answers from `world` as it is when asked, and lists what it was asked.
 * `whileSlackReads` runs while Slack is asked, as anything else that writes to the bridge could.
 * A read whose signal has aborted by the time it would answer proves nothing, as a real one doesn't.
 */
export function fakeFactsReader(
  world: FactsWorld,
  whileSlackReads?: (read: number, signal: AbortSignal) => Promise<unknown>,
) {
  const reads: string[] = [];
  let slackReads = 0;
  const reader: FactsReader = {
    async readToyBox(toyboxChannelId, signal) {
      reads.push(`toybox ${toyboxChannelId}`);
      if (signal.aborted) return timedOut;
      const { toyBox } = world;
      return toyBox && "kind" in toyBox ? toyBox : { kind: "read", facts: toyBox };
    },
    async readSlack(needed, ownerIds, signal) {
      const { monitored, publish, owner, people } = needed;
      reads.push(`slack ${monitored} ${publish} ${owner} [${people.join(" ")}]`);
      await whileSlackReads?.(++slackReads, signal);
      if (signal.aborted) return timedOut;
      if (world.slack) return world.slack;
      const ownerIn = (channelId: string) =>
        ownerIds.some((id) => world.members[channelId]?.includes(id));
      return {
        kind: "read",
        facts: {
          monitored: world.channels[monitored] ?? null,
          publish: world.channels[publish] ?? null,
          ownerInMonitored: ownerIn(monitored),
          ownerInPublish: ownerIn(publish),
          people: people.map((userId) => ({ userId, person: world.people[userId] ?? null })),
        },
      };
    },
  };
  return { reader, reads };
}

const timedOut: Unverified = { kind: "unverified", detail: "the read timed out", retryAt: null };

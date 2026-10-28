import type { Caller } from "@commands/model/callers";
import { CommandRefusedError } from "@commands/model/protocol";
import { channelName } from "@commands/model/slackText";

export type CallerLink = {
  id: string;
  slackChannelId: string;
  /** The Slack channel, as #name. */
  channel: string;
  status: "active" | "paused" | "suspended";
};

/** The link of the caller's Toy Box channel, refusing a caller whose channel has none. */
export async function readCallerLink(sql: Bun.SQL, caller: Caller): Promise<CallerLink> {
  if (caller.channelId === null) {
    throw new CommandRefusedError("Name the Toy Box channel to act for with --channel.");
  }
  const [link] = await sql<Omit<CallerLink, "channel">[]>`
    SELECT id, slack_channel_id AS slackChannelId, status
    FROM links WHERE toybox_channel_id = ${caller.channelId}
  `;
  if (!link) {
    throw new CommandRefusedError(`Toy Box channel ${caller.channelId} isn't linked to Slack.`);
  }
  return { ...link, channel: channelName(null, link.slackChannelId) };
}

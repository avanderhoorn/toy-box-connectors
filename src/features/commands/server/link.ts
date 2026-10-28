import type { Caller } from "@commands/model/callers";
import { CommandRefusedError } from "@commands/model/protocol";
import { channelName } from "@commands/model/slackText";
import { readRequest, type StoredRequest } from "@requests/server/database";

export type CallerLink = {
  id: string;
  toyboxChannelId: string;
  slackChannelId: string;
  /** The Slack channel, as #name. */
  channel: string;
  status: "active" | "paused" | "suspended";
};

/** What a refusal over a request suggests next. */
export const SEE_INBOX = "Run `toy-box-slack inbox` to see what waits on you.";

/** The link of the caller's Toy Box channel, refusing a caller whose channel has none. */
export async function readCallerLink(sql: Bun.SQL, caller: Caller): Promise<CallerLink> {
  if (caller.channelId === null) {
    throw new CommandRefusedError("Name the Toy Box channel to act for with --channel.");
  }
  const [link] = await sql<Omit<CallerLink, "channel">[]>`
    SELECT id, toybox_channel_id AS toyboxChannelId, slack_channel_id AS slackChannelId, status
    FROM links WHERE toybox_channel_id = ${caller.channelId}
  `;
  if (!link) {
    throw new CommandRefusedError(`Toy Box channel ${caller.channelId} isn't linked to Slack.`);
  }
  return { ...link, channel: channelName(null, link.slackChannelId) };
}

/**
 * Request `id` of `link`. Another link's request is refused like a missing one, so a lead learns
 * nothing of it.
 */
export async function readLinkRequest(
  sql: Bun.SQL,
  link: CallerLink,
  id: number,
): Promise<StoredRequest> {
  const request = await readRequest(sql, id);
  if (request === null || request.linkId !== link.id) {
    throw new CommandRefusedError(`This channel has no request r${id}. ${SEE_INBOX}`);
  }
  return request;
}

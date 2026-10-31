import { CommandRefusedError } from "@commands/model/protocol";
import { channelName } from "@commands/model/slackText";
import { readToyBoxLink, type ChannelLink } from "@links/server/database";
import { readRequest, type StoredRequest } from "@requests/server/database";

export type CallerLink = ChannelLink & {
  /** The Slack channel, as #name. */
  channel: string;
};

/** What a refusal over a request suggests next. */
export const SEE_INBOX = "Run `toy-box-slack inbox` to see what waits on you.";

/** The link's Slack channel as #name, or by its ID until Slack has described it. */
export function linkChannelName(
  link: Pick<ChannelLink, "slackChannelName" | "slackChannelId">,
): string {
  return channelName(link.slackChannelName, link.slackChannelId);
}

/** The caller's Toy Box channel, refusing a terminal that didn't name one. */
export function callerChannel(channelId: string | null): string {
  if (channelId === null) {
    throw new CommandRefusedError("Name the Toy Box channel to act for with --channel.");
  }
  return channelId;
}

/** The link of the caller's Toy Box channel, refusing a caller whose channel has none. */
export async function readCallerLink(sql: Bun.SQL, channelId: string | null): Promise<CallerLink> {
  const link = await readToyBoxLink(sql, callerChannel(channelId));
  if (!link) {
    throw new CommandRefusedError(`Toy Box channel ${channelId} isn't linked to Slack.`);
  }
  return { ...link, channel: linkChannelName(link) };
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

import type { WebClient } from "@slack/web-api";
import { historyPageSchema, type HistoryPage } from "@slackapi/model/history";
import type { SlackTs } from "@slackapi/model/ts";

/** One call per page so the caller's shared BotClient owns every method cooldown. */
export async function fetchHistoryPage(
  client: WebClient,
  input: { channelId: string; oldest: SlackTs; latest?: SlackTs; cursor: string | null },
): Promise<HistoryPage> {
  const response = await client.conversations.history({
    channel: input.channelId,
    oldest: input.oldest,
    ...(input.latest === undefined ? {} : { latest: input.latest }),
    ...(input.cursor === null ? {} : { cursor: input.cursor }),
    inclusive: true,
    include_all_metadata: true,
    limit: 200,
  });
  return historyPageSchema.parse(response);
}

export async function fetchThreadPage(
  client: WebClient,
  input: { channelId: string; rootTs: SlackTs; cursor: string | null },
): Promise<HistoryPage> {
  const response = await client.conversations.replies({
    channel: input.channelId,
    ts: input.rootTs,
    ...(input.cursor === null ? {} : { cursor: input.cursor }),
    include_all_metadata: true,
    limit: 200,
  });
  return historyPageSchema.parse(response);
}

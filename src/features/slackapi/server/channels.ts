import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { slackConversationSchema, type ChannelFacts } from "../model/channels";

export async function fetchChannelFacts(
  client: WebClient,
  channelId: string,
): Promise<ChannelFacts | null> {
  try {
    const response = await client.conversations.info({ channel: channelId });
    return slackConversationSchema.parse(response.channel);
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "channel_not_found")
      return null;
    throw error;
  }
}

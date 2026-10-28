import type { ChannelFacts } from "@slackapi/model/channels";
import { readInstallation } from "@slackapi/server/installation";
import { judgeLinkChannel, type ChannelVerdict } from "@links/model/audience";
import { readChannelUses } from "./database";
import { suspendLink } from "./status";

// Linked channels' audiences.
//
// Every fresh read of a linked channel is judged, in the transaction that stores it, against the
// audience the owner approved for each role each link uses it in, never against the read before.

/**
 * Judges a fresh read of a channel for every link that uses it, and suspends each link the read
 * suspends. `facts` is null when Slack can't find the channel. Returns each link's verdict, so the
 * caller holds the posts of a link the read holds. Without an installation nothing is judged.
 */
export async function judgeChannelLinks(
  transaction: Bun.SQL,
  channelId: string,
  facts: ChannelFacts | null,
  now: number,
): Promise<Map<string, ChannelVerdict>> {
  const verdicts = new Map<string, ChannelVerdict>();
  const installation = await readInstallation(transaction);
  if (!installation) return verdicts;
  for (const use of await readChannelUses(transaction, channelId)) {
    const verdict = judgeLinkChannel(use.approved, use, facts, installation);
    if (verdict.kind === "suspended") {
      await suspendLink(transaction, use.linkId, verdict.reason, now);
    }
    verdicts.set(use.linkId, verdict);
  }
  return verdicts;
}

import type { ChannelFacts } from "@slackapi/model/channels";
import { readInstallation } from "@slackapi/server/installation";
import { judgeChannel, type ChannelVerdict } from "@links/model/audience";
import { nameLinkChannel, readChannelLink } from "./database";
import { suspendLink } from "./status";

// A linked channel's audience.
//
// Every fresh read of a linked channel is judged, in the transaction that stores it, against the
// audience the owner approved for it, never against the read before.

/**
 * Judges a fresh read of a channel for the link that watches it, suspends the link unless the read
 * approves it, and keeps the name the read gives the channel. `facts` is null when Slack can't find
 * the channel. Returns the verdict, or null when no link watches the channel or there's no
 * installation to judge it for.
 */
export async function judgeChannelLink(
  transaction: Bun.SQL,
  channelId: string,
  facts: ChannelFacts | null,
  now: number,
): Promise<ChannelVerdict | null> {
  const installation = await readInstallation(transaction);
  const link = await readChannelLink(transaction, channelId);
  if (!installation || !link) return null;
  if (facts?.name) await nameLinkChannel(transaction, link.id, facts.name, now);
  const verdict = judgeChannel(link.approved, facts, installation);
  if (verdict.kind === "suspended") await suspendLink(transaction, link.id, verdict.reason, now);
  return verdict;
}

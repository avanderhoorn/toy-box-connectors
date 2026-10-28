import { readClaim, type ClaimText } from "@links/model/claim";
import { readChannelLink, type ChannelLink } from "@links/server/database";
import { takeDelete, takeMessage } from "@requests/server/intake";
import type { SlackMessageEvent } from "@slackapi/model/messages";
import {
  noteReply,
  storeDelete,
  storeMessage,
  trackRequestThread,
  type LedgerLink,
} from "./ledger";

// Ingest.
//
// Every message event enters the ledger here, whether Socket Mode delivered it or gap repair found
// it, in the transaction that records where it came from. A claim is consumed before anything
// else, and nothing from a channel no link watches is stored. Request policy then runs over what
// the ledger stored.

/** Who the bridge is in Slack, and how a message reached it. */
export type IngestContext = {
  teamId: string;
  botUserId: string;
  ownerUserId: string | null;
  /** Whether gap repair found the message after Socket Mode missed it. */
  late: boolean;
  now: number;
};

export type Ingested =
  /** The message reads as a claim, so it's consumed and never stored. */
  | { kind: "claim"; claim: ClaimText }
  /** No link watches the channel, so nothing is stored. */
  | { kind: "unlinked" }
  /**
   * The link's ledger merged the event. `requestsChanged` says whether any of the link's requests
   * changed, and `purged` lists local copies of files to remove once the transaction commits.
   */
  | { kind: "stored"; linkId: string; requestsChanged: boolean; purged: string[] };

export async function ingestMessageEvent(
  transaction: Bun.SQL,
  event: SlackMessageEvent,
  context: IngestContext,
): Promise<Ingested> {
  if (event.kind === "message") {
    const claim = readClaim(event.message.text, context.botUserId);
    if (claim !== null) return { kind: "claim", claim };
  }
  const channelId = event.kind === "message" ? event.message.channelId : event.channelId;
  const link = await readChannelLink(transaction, channelId);
  if (link === null) return { kind: "unlinked" };

  switch (event.kind) {
    case "message": {
      const { message } = event;
      const stored = await storeMessage(transaction, ledgerLink(link, context), message);
      const intake = await takeMessage(
        transaction,
        { ...link, teamId: context.teamId },
        message,
        stored,
        context,
      );
      if (intake.opened) await trackRequestThread(transaction, link.id, message, context.now);
      return {
        kind: "stored",
        linkId: link.id,
        requestsChanged: intake.changed,
        purged: stored.purged,
      };
    }
    case "deleted": {
      const stored = await storeDelete(transaction, link.id, channelId, event.ts);
      return {
        kind: "stored",
        linkId: link.id,
        requestsChanged: await takeDelete(transaction, channelId, event.ts, context.now),
        purged: stored.purged,
      };
    }
    case "replied":
      if (event.latestReplyTs !== null) {
        await noteReply(transaction, channelId, event.threadTs, event.latestReplyTs);
      }
      return { kind: "stored", linkId: link.id, requestsChanged: false, purged: [] };
  }
}

function ledgerLink(link: ChannelLink, context: IngestContext): LedgerLink {
  return {
    id: link.id,
    audience: {
      teamId: context.teamId,
      ownerUserId: context.ownerUserId,
      allowlist: link.allowlist,
      observe: link.observe,
    },
  };
}

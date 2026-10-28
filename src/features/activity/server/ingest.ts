import { readClaim, type ClaimText } from "@links/model/claim";
import { readChannelLink, type ChannelLink } from "@links/server/database";
import { takeDelete, takeMessage } from "@requests/server/intake";
import type { SlackMessage, SlackMessageEvent } from "@slackapi/model/messages";
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
// else, and nothing from a channel no link watches is stored. An author is stored and asks under
// the ID the bridge knows them by, even when Slack names them by an alias. Request policy then runs
// over what the ledger stored.

/** Who the bridge is in Slack, and how a message reached it. */
export type IngestContext = {
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
      const message = await withKnownAuthor(transaction, event.message);
      const stored = await storeMessage(transaction, ledgerLink(link, context), message);
      const intake = await takeMessage(transaction, link, message, stored, context);
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

/** `message` with its author as the person an alias names, when Slack gave the alias. */
async function withKnownAuthor(transaction: Bun.SQL, message: SlackMessage) {
  if (message.userId === null) return message;
  const [alias] = await transaction<{ user_id: string }[]>`
    SELECT user_id FROM user_aliases WHERE alias_id = ${message.userId}
  `;
  return alias ? { ...message, userId: alias.user_id } : message;
}

function ledgerLink(link: ChannelLink, context: IngestContext): LedgerLink {
  return {
    id: link.id,
    audience: {
      ownerUserId: context.ownerUserId,
      allowlist: link.allowlist,
      observe: link.observe,
    },
  };
}

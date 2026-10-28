import { readChannelLink, type ChannelLink } from "@links/server/database";
import { takeDelete, takeMessage, takeWithdrawal } from "@requests/server/intake";
import type { SlackMessage, SlackMessageEvent } from "@slackapi/model/messages";
import { currentChannelId } from "@slackapi/server/channels";
import { canonicalUserId } from "@slackapi/server/users";
import {
  noteReply,
  storeDelete,
  storeMessage,
  storeWithdrawal,
  trackRequestThread,
  type LedgerLink,
} from "./ledger";

// Ingest.
//
// Every message event enters the ledger here, whether Socket Mode delivered it or gap repair found
// it, in the transaction that records where it came from. Nothing from a channel no link watches
// is stored. An author is stored and asks under the ID the bridge knows them by, even when Slack
// names them by an alias, and a channel is stored under the ID it has now, even when a late event
// names the one Slack moved it from. Request policy then runs over what the ledger stored.

/** Who the bridge is in Slack, and how a message reached it. */
export type IngestContext = {
  botUserId: string;
  /** Whether gap repair found the message after Socket Mode missed it. */
  late: boolean;
  now: number;
};

export type Ingested =
  /** No link watches the channel, so nothing is stored. */
  | { kind: "unlinked" }
  /**
   * The link's ledger merged the event. `requestsChanged` says whether any of the link's requests
   * changed, and `purged` lists local copies of files to remove once the transaction commits.
   */
  | { kind: "stored"; linkId: string; requestsChanged: boolean; purged: string[] };

export async function ingestMessageEvent(
  transaction: Bun.SQL,
  delivered: SlackMessageEvent,
  context: IngestContext,
): Promise<Ingested> {
  const event = await inCurrentChannel(transaction, delivered);
  const channelId = event.kind === "message" ? event.message.channelId : event.channelId;
  const link = await readChannelLink(transaction, channelId);
  if (link === null) return { kind: "unlinked" };

  switch (event.kind) {
    case "message": {
      const message = await withKnownAuthor(transaction, event.message);
      const stored = await storeMessage(transaction, ledgerLink(link), message);
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
    case "withdrawn": {
      const stored = await storeWithdrawal(transaction, link.id, channelId, event.ts);
      return {
        kind: "stored",
        linkId: link.id,
        requestsChanged: await takeWithdrawal(transaction, channelId, event.ts, context.now),
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

/** `event` in its channel's current ID, when it names an ID Slack moved the channel from. */
async function inCurrentChannel(
  transaction: Bun.SQL,
  event: SlackMessageEvent,
): Promise<SlackMessageEvent> {
  if (event.kind !== "message") {
    return { ...event, channelId: await currentChannelId(transaction, event.channelId) };
  }
  const channelId = await currentChannelId(transaction, event.message.channelId);
  return { ...event, message: { ...event.message, channelId } };
}

/** `message` with its author as the person an alias names, when Slack gave the alias. */
async function withKnownAuthor(transaction: Bun.SQL, message: SlackMessage): Promise<SlackMessage> {
  if (message.userId === null) return message;
  return { ...message, userId: await canonicalUserId(transaction, message.userId) };
}

function ledgerLink(link: ChannelLink): LedgerLink {
  return { id: link.id, audience: { allowlist: link.allowlist, observe: link.observe } };
}

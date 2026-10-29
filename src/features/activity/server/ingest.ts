import { readChannelLink, type ChannelLink } from "@links/server/database";
import { hasRequestInThread } from "@requests/server/database";
import { takeDelete, takeMessage } from "@requests/server/intake";
import type { SlackMessage, SlackMessageEvent } from "@slackapi/model/messages";
import { canonicalUserId } from "@slackapi/server/users";
import { storeDelete, storeMessage, type LedgerLink } from "./ledger";

// Ingest.
//
// Every message event enters the ledger here, in the transaction that records where it came from.
// Nothing from a channel no link watches is stored. An author is stored and asks under the ID the
// bridge knows them by, even when Slack names them by an alias. Slack withdrawing a message is
// stored as its delete, since the bridge may no longer keep what it said. Request policy then runs
// over what the ledger stored.

/** Takes a message event. Returns whether it changed a request. */
export async function ingestMessageEvent(
  transaction: Bun.SQL,
  event: SlackMessageEvent,
  now: number,
): Promise<boolean> {
  if (event.kind === "replied") return false;
  const channelId = event.kind === "message" ? event.message.channelId : event.channelId;
  const link = await readChannelLink(transaction, channelId);
  if (link === null) return false;

  if (event.kind !== "message") {
    await storeDelete(transaction, link.id, channelId, event.ts);
    return takeDelete(transaction, channelId, event.ts, now);
  }
  const message = await withKnownAuthor(transaction, event.message);
  const inRequestThread = await hasRequestInThread(transaction, link.id, message.rootTs);
  const stored = await storeMessage(transaction, ledgerLink(link), message, inRequestThread);
  return takeMessage(transaction, link, message, stored, now);
}

/** `message` with its author as the person an alias names, when Slack gave the alias. */
async function withKnownAuthor(transaction: Bun.SQL, message: SlackMessage): Promise<SlackMessage> {
  if (message.userId === null) return message;
  return { ...message, userId: await canonicalUserId(transaction, message.userId) };
}

function ledgerLink(link: ChannelLink): LedgerLink {
  return { id: link.id, audience: { allowlist: link.allowlist, observe: link.observe } };
}

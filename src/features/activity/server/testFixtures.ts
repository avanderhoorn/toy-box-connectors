import type { LinkAudience } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import type { SlackMessage } from "@slackapi/model/messages";
import { storeMessage, type LedgerLink } from "./ledger";

/**
 * The ledger's view of the link `createStoredLink` stores: U-owner and U-allowed may ask, and
 * others keep their text only in request threads. `audience` replaces its settings.
 */
export function ledgerLink(audience: Partial<LinkAudience> = {}): LedgerLink {
  return {
    id: "link",
    audience: {
      allowlist: new Set(["U-owner", "U-allowed"]),
      observe: "requesters",
      ...audience,
    },
  };
}

/** Persist `message` in the ledger of the link `createStoredLink` stores. */
export function createStoredMessage(
  database: BridgeDatabase,
  message: SlackMessage,
  link = ledgerLink(),
) {
  return database.write((transaction) => storeMessage(transaction, link, message));
}

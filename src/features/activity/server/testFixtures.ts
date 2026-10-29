import type { LinkAudience } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import type { SlackMessage } from "@slackapi/model/messages";
import { storeMessage } from "./ledger";

/**
 * The ledger's view of the link `createStoredLink` stores: U-owner and U-allowed may ask, and
 * others keep their text only in request threads. `audience` replaces its settings.
 */
export function linkAudience(audience: Partial<LinkAudience> = {}): LinkAudience {
  return { allowlist: new Set(["U-owner", "U-allowed"]), observe: "requesters", ...audience };
}

/** Persist `message` in the ledger, with the audience of the link `createStoredLink` stores. */
export function createStoredMessage(
  database: BridgeDatabase,
  message: SlackMessage,
  audience = linkAudience(),
  inRequestThread = false,
) {
  return database.write((transaction) =>
    storeMessage(transaction, audience, message, inRequestThread),
  );
}

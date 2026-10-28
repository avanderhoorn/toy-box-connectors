import type { BridgeDatabase } from "@bridge/server/database";
import { openRequest, type Request } from "@requests/model/lifecycle";
import { insertRequest } from "./database";

/**
 * Persist a request the owner opened at time 0 by mentioning the bot at the root of the channel
 * `createStoredLink` links. `changes` replace its fields, such as its state or requester.
 */
export function createStoredRequest(database: BridgeDatabase, changes: Partial<Request> = {}) {
  const request = openRequest(
    {
      linkId: "link",
      channelId: "C-link",
      rootTs: "1700000100.000100",
      sourceTs: "1700000100.000100",
      requesterUserId: "U-owner",
      reason: "mention",
    },
    0,
  );
  return database.write((transaction) => insertRequest(transaction, { ...request, ...changes }));
}

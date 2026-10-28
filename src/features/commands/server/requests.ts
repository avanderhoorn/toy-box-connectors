// Finding the request a lead's command names.
//
// A command acts only on a request of the caller's own link. It reads the request in the
// transaction that then changes it, so the checks it runs still hold when it writes.

import type { BridgeDatabase } from "@bridge/server/database";
import type { ChannelCaller } from "@commands/model/callers";
import { CommandRefusedError } from "@commands/model/contract";
import { notLinked } from "@commands/model/unlinked";
import { readRequest, type StoredRequest } from "@requests/server/database";
import type { WakeScheduler } from "@wakes/server";

/** What a request command needs to change a request. */
export type RequestCommandOptions = {
  database: BridgeDatabase;
  wakes: Pick<WakeScheduler, "reconsider">;
};

/**
 * The request `id` of the link that follows the caller's Toy Box channel. Refuses one of another
 * link the same way as one that doesn't exist, so a lead learns nothing about other channels.
 */
export async function readCallerRequest(
  transaction: Bun.SQL,
  caller: ChannelCaller,
  id: number,
): Promise<StoredRequest> {
  const [link] = await transaction<{ id: string }[]>`
    SELECT id FROM links WHERE toybox_channel_id = ${caller.channelId}
  `;
  if (!link) {
    throw new CommandRefusedError("not_linked", notLinked(caller.role, `so it has no r${id}`));
  }
  const request = await readRequest(transaction, id);
  if (request === null || request.linkId !== link.id) {
    throw new CommandRefusedError(
      "unknown_request",
      `This channel has no request r${id}. Run \`toy-box-slack inbox\` to see its requests.`,
    );
  }
  return request;
}

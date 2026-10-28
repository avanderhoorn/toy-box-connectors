// The lifecycle refuses to dismiss a request the lead hasn't read as it stands, so none ends over
// text the lead didn't see.

import type { BridgeDatabase } from "@bridge/server/database";
import { CommandRefusedError } from "@commands/model/protocol";
import { dismissRequest, RequestStateError } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import type { WakeScheduler } from "@wakes/server";
import { readCallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type DismissCommandOptions = {
  database: BridgeDatabase;
  wakes: Pick<WakeScheduler, "reconsider">;
};

export function dismissCommand({
  database,
  wakes,
}: DismissCommandOptions): CommandHandler<"dismiss"> {
  return async ({ request: id, reason }, { caller }) => {
    await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, caller);
      const request = await readRequest(transaction, id);
      // Another link's request is refused like a missing one, so a lead learns nothing of it.
      if (request === null || request.linkId !== link.id) {
        throw new CommandRefusedError(
          `This channel has no request r${id}. Run \`toy-box-slack inbox\` to see what waits on you.`,
        );
      }
      try {
        await saveRequest(transaction, dismissRequest(request, reason));
      } catch (error) {
        if (!(error instanceof RequestStateError)) throw error;
        throw new CommandRefusedError(
          `r${id} wasn't dismissed. ${error.message} Run \`toy-box-slack inbox\` to see what waits on you.`,
        );
      }
    });
    wakes.reconsider();
    return { result: { request: `r${id}`, state: "dismissed" }, text: `Dismissed r${id}.` };
  };
}

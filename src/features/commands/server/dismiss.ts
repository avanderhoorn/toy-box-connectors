// The lifecycle refuses to dismiss a request the lead hasn't read as it stands, so none ends over
// text the lead didn't see.

import type { BridgeDatabase } from "@bridge/server/database";
import { CommandRefusedError } from "@commands/model/protocol";
import { dismissRequest, RequestStateError } from "@requests/model/lifecycle";
import { saveRequest } from "@requests/server/database";
import type { WakeScheduler } from "@wakes/server";
import { readCallerLink, readLinkRequest, SEE_INBOX } from "./link";
import type { CommandHandler } from "./serve";

export type DismissCommandOptions = {
  database: BridgeDatabase;
  wakes: Pick<WakeScheduler, "reconsider">;
};

export function dismissCommand({
  database,
  wakes,
}: DismissCommandOptions): CommandHandler<"dismiss"> {
  return async ({ request: id, reason }, { channelId }) => {
    await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, channelId);
      const request = await readLinkRequest(transaction, link, id);
      try {
        await saveRequest(transaction, dismissRequest(request, reason));
      } catch (error) {
        if (!(error instanceof RequestStateError)) throw error;
        throw new CommandRefusedError(`r${id} wasn't dismissed. ${error.message} ${SEE_INBOX}`);
      }
    });
    wakes.reconsider();
    return { result: { request: `r${id}`, state: "dismissed" }, text: `Dismissed r${id}.` };
  };
}

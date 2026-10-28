// The hold command.
//
// Hold checks and holds the request in one transaction, then asks the wake scheduler to decide
// again, so the request's reminder is dropped as soon as the hold is stored.

import { CommandRefusedError, type CommandHandler } from "@commands/model/contract";
import type { holdContract } from "@commands/model/hold";
import { requestStateProblem } from "@commands/model/requests";
import { holdRequest } from "@requests/model/lifecycle";
import { saveRequest } from "@requests/server/database";
import { readCallerRequest, type RequestCommandOptions } from "./requests";

/** Hold for the caller's channel, which stops reminders about one request. */
export function holdCommand({
  database,
  wakes,
}: RequestCommandOptions): CommandHandler<typeof holdContract> {
  return async ({ request: id, reason }, { caller, at }) => {
    const held = await database.write(async (transaction) => {
      const request = await readCallerRequest(transaction, caller, id);
      const problem = requestStateProblem(request);
      if (problem) throw new CommandRefusedError(problem.rule, problem.message);
      const held = holdRequest(request, reason, at);
      await saveRequest(transaction, held);
      return held;
    });
    wakes.reconsider();
    return { request: held.id, attention: held.attention, expiresAt: held.expiresAt };
  };
}

// The dismiss command.
//
// Dismiss checks the request and the revision the lead quotes, then closes the request, in one
// transaction, so input that arrives in between makes it refuse rather than close over text the
// lead never read. It then asks the wake scheduler to decide again, since the request no longer
// waits on the lead.

import { CommandRefusedError, type CommandHandler } from "@commands/model/contract";
import type { dismissContract } from "@commands/model/dismiss";
import { requestStateProblem, revisionProblem } from "@commands/model/requests";
import { dismissStoredRequest } from "@requests/server/lifecycle";
import { readCallerRequest, type RequestCommandOptions } from "./requests";

/** Dismiss for the caller's channel, which closes one request without an answer. */
export function dismissCommand({
  database,
  wakes,
}: RequestCommandOptions): CommandHandler<typeof dismissContract> {
  return async ({ request: id, revision, reason }, { caller, at }) => {
    await database.write(async (transaction) => {
      const request = await readCallerRequest(transaction, caller.channelId, id);
      const problem = requestStateProblem(request) ?? revisionProblem(request, revision);
      if (problem) throw new CommandRefusedError(problem.rule, problem.message);
      await dismissStoredRequest(transaction, request, reason, at);
    });
    wakes.reconsider();
    return { request: id };
  };
}

// Every command the bridge serves.
//
// The CLI offers exactly these commands and the bridge serves exactly these. The bridge's handler
// map must name one handler for each, so a command can't exist on one side only.

import type { CommandContract, CommandHandlersFor } from "./contract";
import { inboxContract } from "./inbox";
import { statusContract } from "./status";

export const commandContracts = {
  status: statusContract,
  inbox: inboxContract,
} satisfies Record<string, CommandContract>;

export type CommandName = keyof typeof commandContracts;

/** One handler for every command the bridge serves. */
export type CommandHandlers = CommandHandlersFor<typeof commandContracts>;

/** Whether `name` is a command the bridge serves. */
export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(commandContracts, name);
}

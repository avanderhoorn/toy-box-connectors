// Command contracts.
//
// A contract is everything both ends of the socket agree on for one command: who may run it,
// whether it acts for one Toy Box channel, the input it takes, the result it returns and how the
// CLI shows that result. The CLI builds its grammar from contracts, and the bridge checks every
// call against the same contract before a handler runs, so a command can't mean one thing to the
// lead and another to the bridge.

import type { z } from "zod";
import type { Caller, CallerRole, ChannelCaller, CommandScope } from "./callers";

/** Everything the CLI and the bridge agree on about one command. */
export type CommandContract<
  Input extends z.ZodObject = z.ZodObject,
  Result extends z.ZodType = z.ZodType,
  Scope extends CommandScope = CommandScope,
> = {
  /** One line for `--help`. */
  description: string;
  roles: readonly CallerRole[];
  scope: Scope;
  /** A strict object. The CLI offers each field as an option named for it in kebab case. */
  input: Input;
  /** The input fields the CLI takes as arguments instead, in order. Only the last may be a list. */
  positionals?: readonly (keyof z.output<Input> & string)[];
  /** The text field the CLI reads from stdin when no option sets it. */
  stdin?: keyof z.output<Input> & string;
  result: Result;
  /** The result as Markdown for the CLI, ending with the next step when there is one. */
  present(result: z.output<Result>, context: PresentContext): string;
};

/** What a presenter knows besides the result. */
export type PresentContext = {
  /** When the bridge took the call, so ages read the same however late the CLI prints them. */
  at: number;
};

/** Declares a command's contract, keeping the types of its schemas and its scope. */
export function commandContract<
  Input extends z.ZodObject,
  Result extends z.ZodType,
  Scope extends CommandScope,
>(contract: CommandContract<Input, Result, Scope>): CommandContract<Input, Result, Scope> {
  return contract;
}

/** What a handler learns about its call besides the input. */
export type CommandCall<Scope extends CommandScope = CommandScope> = {
  /** A channel command's caller always acts for one channel. */
  caller: Scope extends "channel" ? ChannelCaller : Caller;
  /** When the bridge took the call. Handlers read the time from here. */
  at: number;
};

/** Runs one command for a caller its contract allows, with input its contract parsed. */
export type CommandHandler<Contract extends CommandContract> = (
  input: z.output<Contract["input"]>,
  call: CommandCall<Contract["scope"]>,
) => Promise<z.input<Contract["result"]>>;

/**
 * A handler's refusal. The caller sees its message, which says what happened and what to do
 * instead, and the CLI exits 1.
 */
export class CommandRefusedError extends Error {
  constructor(
    /** The rule that refused the call, in snake case, for anyone reading `--json`. */
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

// The socket protocol.
//
// The CLI posts each call to `/v1/commands/<name>` on the bridge's Unix socket, with what its
// environment says about the caller and the values it read. The bridge answers 200 with the
// command's result and the Markdown the CLI prints, or with an error that says what to do instead.

import { z } from "zod";
import { callerFactsSchema } from "./callers";

/**
 * How long the CLI waits for the bridge to answer, in milliseconds. A command may still finish after
 * that, but its caller has been told it may or may not have run, so every command answers well
 * within it.
 */
export const COMMAND_TIMEOUT = 60_000;

const COMMANDS_PATH = "/v1/commands/";

/** The path a command's calls are posted to. */
export function commandPath(name: string): string {
  return `${COMMANDS_PATH}${name}`;
}

/** The command a call to `path` names, or null when it names none. */
export function commandAt(path: string): string | null {
  return path.startsWith(COMMANDS_PATH) ? path.slice(COMMANDS_PATH.length) : null;
}

/** One call, as the CLI posts it. The command's input schema checks the values. */
export const commandCallSchema = z
  .object({
    caller: callerFactsSchema,
    input: z.record(z.string(), z.unknown()).describe("The values the CLI read, by field"),
  })
  .strict();
export type CommandCall = z.output<typeof commandCallSchema>;

/** What a command that ran answers: its result for --json, and the Markdown the CLI prints. */
export type CommandAnswer = { result: unknown; text: string };

/** The bridge's answer to a call it didn't run, or couldn't finish. */
export const commandErrorSchema = z.object({ error: z.string() }).strict();

/** A command's refusal, whose message says what happened and what to do instead. */
export class CommandRefusedError extends Error {}

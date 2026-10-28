// The socket protocol.
//
// The CLI posts each call to `/v1/commands/<name>` on the bridge's Unix socket with what its
// environment says about the caller and the input the command's contract parsed. The bridge
// answers with the command's result, or with a refusal that says which rule refused the call and
// what to do instead. Either carries the banner, except a refusal of the caller itself, which
// learns nothing about a channel it can't act for. `--json` prints the answer as it came.

import { z } from "zod";
import { bannerSchema } from "./banner";
import { callerFactsSchema } from "./callers";

/** The protocol version every answer carries. A CLI refuses an answer of another. */
export const PROTOCOL_VERSION = 1;

/**
 * How long the CLI waits for the bridge to answer a call, in milliseconds. A command may still
 * finish after that, but its caller has been told it may or may not have run, so every command
 * answers well within it.
 */
export const COMMAND_TIMEOUT = 60_000;

const COMMANDS_PATH = "/v1/commands/";

/** The path a command's calls are posted to. */
export function commandPath(name: string): string {
  return `${COMMANDS_PATH}${name}`;
}

/** The command a call to `path` names, or null when the path names none. */
export function commandAt(path: string): string | null {
  if (!path.startsWith(COMMANDS_PATH)) return null;
  const name = path.slice(COMMANDS_PATH.length);
  return /^[a-z][a-z-]*$/.test(name) ? name : null;
}

/** One call, as the CLI posts it. The input stays unchecked until the command's contract parses it. */
export const commandRequestSchema = z
  .object({
    caller: callerFactsSchema,
    input: z.record(z.string(), z.unknown()).describe("The values the CLI read, by field"),
  })
  .strict();
export type CommandRequest = z.output<typeof commandRequestSchema>;

/** Why the bridge didn't run a call, and what the caller can do instead. */
export const refusalSchema = z
  .object({
    rule: z.string().describe("The rule that refused the call, in snake case"),
    message: z.string().describe("What happened and what to do instead"),
  })
  .strict();
export type Refusal = z.output<typeof refusalSchema>;

const atSchema = z.number().int().nonnegative().describe("When the bridge took the call");

/** The bridge's answer to a call it ran. */
export function commandResultSchema<Result extends z.ZodType>(result: Result) {
  return z
    .object({ version: z.literal(PROTOCOL_VERSION), at: atSchema, banner: bannerSchema, result })
    .strict();
}

/** The bridge's answer to a call it refused. */
export const commandRefusalSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    at: atSchema,
    banner: bannerSchema.nullable().describe("Null when the caller itself was refused"),
    refused: refusalSchema,
  })
  .strict();
export type CommandRefusal = z.output<typeof commandRefusalSchema>;

/** The bridge's answer to a request it couldn't take, such as an unknown command. */
export const commandErrorSchema = z.object({ error: z.string() }).strict();

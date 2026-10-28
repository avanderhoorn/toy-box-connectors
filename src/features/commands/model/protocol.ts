// The CLI posts each call to the bridge's Unix socket. The bridge answers 200 with the command's
// result and the Markdown the CLI prints, or with an error that says what to do instead.

import { z } from "zod";
import { callerFactsSchema } from "./callers";

/** Where calls are posted, followed by the command's name. */
export const COMMANDS_PATH = "/v1/commands/";

/** How long the CLI waits for an answer, in milliseconds, so every command answers well within it. */
export const COMMAND_TIMEOUT = 60_000;

/** One call, as the CLI posts it. The command's input schema checks the values. */
export const commandCallSchema = z
  .object({
    caller: callerFactsSchema,
    input: z.record(z.string(), z.unknown()).describe("The values the CLI read, by field"),
    owner: z
      .object({ passphrase: z.string().min(1), confirms: z.string() })
      .strict()
      .optional()
      .describe("The owner's passphrase, and the name of the change they were shown"),
  })
  .strict();
export type CommandCall = z.output<typeof commandCallSchema>;

/**
 * What a command that ran answers: its result for --json, and the Markdown the CLI prints. One that
 * would widen access answers first with what it would change, and `confirm` names that change.
 */
export const commandAnswerSchema = z
  .object({ result: z.unknown(), text: z.string(), confirm: z.string().optional() })
  .strict();
export type CommandAnswer = z.output<typeof commandAnswerSchema>;

export const commandErrorSchema = z.object({ error: z.string() }).strict();

/** A command's refusal, whose message says what happened and what to do instead. */
export class CommandRefusedError extends Error {}

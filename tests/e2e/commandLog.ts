// The log of commands the lead ran from the end-to-end harness's PATH folder.
//
// Each command there runs its target, if it has one, and then this script, which appends the run
// to the log. A run records only the variables that show where it ran, because the lead's
// environment also holds the Copilot token.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const commandRunSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  status: z.number().int(),
  env: z.object({
    HOME: z.string().optional(),
    NITRO_PORT: z.string().optional(),
    COPILOT_AGENT_SESSION_ID: z.string().optional(),
  }),
});
export type CommandRun = z.output<typeof commandRunSchema>;

/** Every run in the log at `path`, oldest first. */
export function readCommandLog(path: string): CommandRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => commandRunSchema.parse(JSON.parse(line)));
}

if (import.meta.main) {
  const [log, command, status, ...args] = process.argv.slice(2);
  const { HOME, NITRO_PORT, COPILOT_AGENT_SESSION_ID } = process.env;
  const run: CommandRun = {
    command,
    args,
    status: Number(status),
    env: { HOME, NITRO_PORT, COPILOT_AGENT_SESSION_ID },
  };
  appendFileSync(log, `${JSON.stringify(run)}\n`);
}

// The CLI.
//
// Every command the bridge serves becomes a citty command whose options are its input's fields,
// plus --channel and --json. The CLI forwards the text it read with what its environment says about
// the caller, prints the answer, and exits 0 when the command ran, 1 when it didn't or may not
// have, and 2 when no bridge is running. It keeps no state, and never talks to Slack or Toy Box.

import { homedir } from "node:os";
import { defineCommand, type ArgsDef, type CommandDef } from "citty";
import { resolveDataFolder } from "@bridge/server/dataFolder";
import { BridgeRefusedError } from "@bridge/server/refusal";
import { commandSocketPath } from "@bridge/server/socket";
import { commands, optionName, type CommandSpec } from "@commands/model";
import { readCallerFacts } from "@commands/model/callers";
import {
  COMMAND_TIMEOUT,
  commandErrorSchema,
  commandPath,
  type CommandAnswer,
  type CommandCall,
} from "@commands/model/protocol";

export type ExitCode = 0 | 1 | 2;

/** How a call went: its exit code, the Markdown to print, and what --json prints instead. */
export type CallOutcome = { exitCode: ExitCode; text: string; json: unknown };

export type CallOptions = {
  /** The Toy Box channel --channel names. */
  channelId?: string | null;
  env?: Record<string, string | undefined>;
  home?: string;
  /** How long to wait for the bridge's answer, in milliseconds. */
  timeout?: number;
};

const sharedArgs = {
  channel: {
    type: "string",
    description: "The Toy Box channel to act for, when you run it at a terminal",
  },
  json: { type: "boolean", description: "Print the result as JSON" },
} as const satisfies ArgsDef;

// Errors that mean nothing listens on the socket, so the call never reached a bridge.
const notListening = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ECONNREFUSED", "ENOTSOCK"]);

/** A citty command for each command the bridge serves. */
export function socketCommands(): Record<string, CommandDef> {
  return Object.fromEntries(
    Object.entries(commands).map(([name, spec]) => [name, socketCommand(name, spec)]),
  );
}

/** Calls `name` on the bridge with `input`, as `toy-box-slack <name>` does. */
export async function callBridge(
  name: string,
  input: Record<string, unknown>,
  {
    channelId = null,
    env = process.env,
    home = homedir(),
    timeout = COMMAND_TIMEOUT,
  }: CallOptions = {},
): Promise<CallOutcome> {
  let dataFolder: string;
  try {
    dataFolder = resolveDataFolder(env, home);
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    return failed(1, error.message);
  }
  const call: CommandCall = { caller: readCallerFacts(env, channelId), input };
  let response: Response;
  try {
    response = await fetch(`http://localhost${commandPath(name)}`, {
      unix: commandSocketPath(dataFolder),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(call),
      keepalive: false,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (notListening.has((error as { code?: string } | null)?.code ?? "")) {
      return failed(
        2,
        `No bridge is running for ${dataFolder}, so \`${name}\` didn't run. Start it with \`toy-box-slack serve\`.`,
      );
    }
    return failed(1, unanswered(name));
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok && isAnswer(body)) return { exitCode: 0, text: body.text, json: body.result };
  const error = commandErrorSchema.safeParse(body);
  return failed(1, error.success ? error.data.error : unanswered(name));
}

/** Prints `outcome` as the CLI does, as JSON on stdout with --json. */
export function printOutcome({ exitCode, text, json }: CallOutcome, asJson: boolean): void {
  if (asJson) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  else process[exitCode === 0 ? "stdout" : "stderr"].write(`${text}\n`);
}

function socketCommand(name: string, spec: CommandSpec): CommandDef {
  const fields = Object.entries(spec.input.shape);
  const args: ArgsDef = { ...sharedArgs };
  for (const [field, schema] of fields) {
    const { description } = schema;
    args[optionName(field)] = spec.positionals?.includes(field)
      ? { type: "positional", description, required: !schema.safeParse(undefined).success }
      : { type: "string", description };
  }
  return defineCommand({
    meta: { name, description: spec.description },
    args,
    async run({ args: read }) {
      const input: Record<string, unknown> = {};
      for (const [field] of fields) input[field] = read[optionName(field)];
      const channelId = typeof read.channel === "string" ? read.channel : null;
      const outcome = await callBridge(name, input, { channelId });
      printOutcome(outcome, read.json === true);
      process.exitCode = outcome.exitCode;
    },
  });
}

function failed(exitCode: ExitCode, error: string): CallOutcome {
  return { exitCode, text: error, json: { error } };
}

function unanswered(name: string): string {
  return `The bridge didn't answer \`${name}\`, so it may or may not have run. Run \`toy-box-slack status\` before you try again.`;
}

function isAnswer(body: unknown): body is CommandAnswer {
  return typeof body === "object" && body !== null && "text" in body && "result" in body;
}

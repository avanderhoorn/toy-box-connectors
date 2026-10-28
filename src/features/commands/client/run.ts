// Running a command from the CLI.
//
// The CLI reads a command line against the command's contract and checks its input the way the
// bridge will, so a mistake is caught even while the bridge is down. Then it posts the call to the
// bridge's socket with what its environment says about the caller, prints the answer, and exits
// with the code that says what happened. It keeps no state, and it never talks to Slack or Toy
// Box itself.

import { homedir } from "node:os";
import { isatty } from "node:tty";
import type { z } from "zod";
import { resolveDataFolder } from "@bridge/server/dataFolder";
import { BridgeRefusedError } from "@bridge/server/refusal";
import { commandSocketPath } from "@bridge/server/socket";
import { readCallerFacts } from "@commands/model/callers";
import { checkCommandInput, parseCommandLine } from "@commands/model/commandLine";
import type { CommandContract } from "@commands/model/contract";
import {
  explain,
  explainNoAnswer,
  readAnswer,
  readCallFailure,
  type CommandOutcome,
  type ExitCode,
} from "@commands/model/outcome";
import { COMMAND_TIMEOUT, commandPath, type CommandRequest } from "@commands/model/protocol";

/** Where the CLI prints: Markdown on stdout when a command ran and on stderr when it didn't. */
export type Print = (stream: "stdout" | "stderr", text: string) => void;

export type CallOptions = {
  /** The Toy Box channel to act for, as --channel names it. */
  channelId?: string | null;
  env?: Record<string, string | undefined>;
  home?: string;
  /** How long to wait for the bridge's answer, in milliseconds. */
  timeout?: number;
};

export type CommandLineOptions = Omit<CallOptions, "channelId"> & {
  /** Reads stdin to its end, or resolves with null when it's a terminal no one is piping into. */
  readStdin?: () => Promise<string | null>;
  print?: Print;
};

/** Runs `toy-box-slack <name> <args>`, prints how it went, and returns the exit code. */
export async function runCommandLine(
  name: string,
  contract: CommandContract,
  args: readonly string[],
  { readStdin = readProcessStdin, print = printToProcess, ...options }: CommandLineOptions = {},
): Promise<ExitCode> {
  const parsed = parseCommandLine(name, contract, args);
  if (parsed.kind === "refused") {
    return printOutcome(explain(1, parsed.message), args.includes("--json"), print);
  }
  const { values, channelId, json } = parsed;
  if (contract.stdin !== undefined && values[contract.stdin] === undefined) {
    // A heredoc ends with a newline that isn't part of the text.
    const text = (await readStdin())?.trimEnd();
    if (text) values[contract.stdin] = text;
  }
  const checked = checkCommandInput(name, contract, values);
  if (checked.kind === "refused") return printOutcome(explain(1, checked.message), json, print);
  const outcome = await callCommand(name, contract, values, { ...options, channelId });
  return printOutcome(outcome, json, print);
}

/**
 * Calls `name` with `input` the way `toy-box-slack <name>` does, for a command that runs others
 * as its steps. The bridge checks `input` against the contract.
 */
export async function callCommand<Result extends z.ZodType>(
  name: string,
  contract: CommandContract<z.ZodObject, Result>,
  input: Record<string, unknown>,
  {
    channelId = null,
    env = process.env,
    home = homedir(),
    timeout = COMMAND_TIMEOUT,
  }: CallOptions = {},
): Promise<CommandOutcome<z.output<Result>>> {
  let dataFolder: string;
  try {
    dataFolder = resolveDataFolder(env, home);
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    return explain(1, error.message);
  }
  const address = { dataFolder, socket: commandSocketPath(dataFolder) };
  const request: CommandRequest = { caller: readCallerFacts(env, channelId), input };
  let answer: { status: number; text: string };
  try {
    const response = await fetch(`http://localhost${commandPath(name)}`, {
      unix: address.socket,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      keepalive: false,
      signal: AbortSignal.timeout(timeout),
    });
    answer = { status: response.status, text: await response.text() };
  } catch (error) {
    return explainNoAnswer(name, readCallFailure(error, timeout), address);
  }
  return readAnswer(name, contract, { status: answer.status, body: parseJson(answer.text) });
}

/** Prints `outcome`, as JSON on stdout with --json, and returns its exit code. */
export function printOutcome(outcome: CommandOutcome, json: boolean, print: Print): ExitCode {
  if (json) print("stdout", `${JSON.stringify(outcome.json, null, 2)}\n`);
  else print(outcome.exitCode === 0 ? "stdout" : "stderr", `${outcome.text}\n`);
  return outcome.exitCode;
}

/** Prints to the process's own stdout or stderr. */
export function printToProcess(stream: "stdout" | "stderr", text: string): void {
  process[stream].write(text);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readProcessStdin(): Promise<string | null> {
  if (isatty(0)) return null;
  return await Bun.stdin.text();
}

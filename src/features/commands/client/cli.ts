// The CLI forwards the text it read and what its environment says about the caller to the bridge,
// and prints the answer. It exits 0 when the command ran, 1 when it didn't or may not have, and 2
// when no bridge is running. A command that posts reads its text from stdin unless --text gives it,
// and sends the bytes of the files a path field names, refusing one it can't read or that's too big
// without calling the bridge.

import { homedir } from "node:os";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { defineCommand, type ArgsDef, type CommandDef } from "citty";
import { z } from "zod";
import { resolveDataFolder } from "@bridge/server/dataFolder";
import { commandSocketPath } from "@bridge/server/socket";
import { commands, didntRun, optionName, orList, type CommandSpec } from "@commands/model";
import { resolveSessionId } from "@commands/model/callers";
import {
  COMMAND_TIMEOUT,
  COMMANDS_PATH,
  commandAnswerSchema,
  commandErrorSchema,
  type CommandCall,
} from "@commands/model/protocol";

/** How a call went: its exit code, the Markdown to print, and what --json prints instead. */
export type CallOutcome = { exitCode: 0 | 1 | 2; text: string; json: unknown };

/** What a command line asks of a command, and why the command can't run as given. */
export type CommandLine = {
  input: Record<string, unknown>;
  channelId: string | null;
  json: boolean;
  problems: string[];
};

export type CallOptions = {
  channelId?: string | null;
  env?: Record<string, string | undefined>;
  home?: string;
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

export function socketCommands(): Record<string, CommandDef> {
  return Object.fromEntries(
    Object.entries(commands).map(([name, spec]) => [name, socketCommand(name, spec)]),
  );
}

/** Calls `name` on the bridge with `input`, as `toy-box-slack <name>` does. */
export async function callBridge(
  name: string,
  input: Record<string, unknown>,
  { channelId = null, env = process.env, home = homedir() }: CallOptions = {},
): Promise<CallOutcome> {
  const dataFolder = resolveDataFolder(env, home);
  const sessionId = resolveSessionId(env);
  const call: CommandCall = { caller: { sessionId, channelId }, input };
  let response: Response;
  try {
    response = await fetch(`http://localhost${COMMANDS_PATH}${name}`, {
      unix: commandSocketPath(dataFolder),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(call),
      keepalive: false,
      signal: AbortSignal.timeout(COMMAND_TIMEOUT),
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
  const answer = commandAnswerSchema.safeParse(body);
  if (response.ok && answer.success) {
    const { result, text } = answer.data;
    return { exitCode: 0, text, json: result };
  }
  const error = commandErrorSchema.safeParse(body);
  return failed(1, error.success ? error.data.error : unanswered(name));
}

function socketCommand(name: string, spec: CommandSpec): CommandDef {
  const args: ArgsDef = { ...sharedArgs };
  for (const [field, { description }] of Object.entries(spec.input.shape)) {
    const option = optionName(field);
    if (spec.positionals?.includes(field)) {
      // citty would answer a missing one with its usage, so the bridge refuses it instead, the way
      // it refuses anything else, in JSON under --json.
      args[option] = { type: "positional", description, required: false };
    } else {
      args[option] = { type: "string", description };
    }
  }
  return defineCommand({
    meta: { name, description: spec.description },
    args,
    async run({ rawArgs }) {
      const { input, channelId, json, problems } = readCommandLine(spec, rawArgs);
      if (!problems.length) problems.push(...(await readPaths(spec, input)));
      // A terminal isn't kept waiting for text, since only a lead may post.
      if (
        !problems.length &&
        Object.hasOwn(spec.input.shape, "text") &&
        input.text === undefined &&
        !process.stdin.isTTY
      ) {
        input.text = await Bun.stdin.text();
      }
      const outcome = problems.length
        ? failed(1, didntRun(name, problems))
        : await callBridge(name, input, { channelId });
      if (json) {
        process.stdout.write(`${JSON.stringify(outcome.json, null, 2)}\n`);
      } else process[outcome.exitCode === 0 ? "stdout" : "stderr"].write(`${outcome.text}\n`);
      process.exitCode = outcome.exitCode;
    },
  });
}

/** Reads a command line for the command `spec` describes, as `toy-box-slack <name>` does. */
export function readCommandLine(spec: CommandSpec, rawArgs: string[]): CommandLine {
  const fields = Object.entries(spec.input.shape);
  const lists = new Set(fields.flatMap(([field, schema]) => (takesList(schema) ? [field] : [])));
  // Every option reads each time it's given, so a list takes them all, and any other option given
  // twice is refused rather than keeping one.
  const options: ParseArgsOptionsConfig = {
    channel: { type: "string", multiple: true },
    json: { type: "boolean", multiple: true },
  };
  const singles = ["channel", "json"];
  for (const [field] of fields) {
    if (spec.positionals?.includes(field)) continue;
    options[optionName(field)] = { type: "string", multiple: true };
    if (!lists.has(field)) singles.push(optionName(field));
  }
  const { values, positionals, tokens } = parseArgs({
    args: rawArgs,
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const given = (option: string) =>
    [values[option] ?? []].flat().map((value) => (typeof value === "string" ? value : ""));
  // A positional is no option, and neither is a spelling `--help` doesn't show. Options come
  // first, since an argument beside one was likely meant as its value.
  const unknown = new Set(
    tokens.flatMap((token) =>
      token.kind === "option" && !Object.hasOwn(options, token.name) ? [token.rawName] : [],
    ),
  );
  const last = spec.positionals?.at(-1);
  const room = last && lists.has(last) ? Infinity : (spec.positionals?.length ?? 0);
  const unwanted = unknown.size
    ? [...unknown]
    : positionals.slice(room).map((value) => `\`${value}\``);
  const repeated = singles.filter((option) => given(option).length > 1);
  const input: Record<string, unknown> = {};
  for (const [field] of fields) {
    const position = spec.positionals?.indexOf(field) ?? -1;
    const taken =
      position < 0
        ? given(optionName(field))
        : positionals.slice(position, lists.has(field) ? undefined : position + 1);
    // Left out when not given, so a bridge of another release isn't sent an option it doesn't
    // take.
    if (taken.length) input[field] = lists.has(field) ? taken : taken[0];
  }
  const problems = [
    ...(unwanted.length ? [`It doesn't take ${orList(unwanted)}.`] : []),
    ...repeated.map((option) => `--${option}: Give it once.`),
  ];
  const [channelId = null] = given("channel");
  return { input, channelId, json: [values.json].flat()[0] === true, problems };
}

/** Whether `schema` takes a list, of the arguments left or of an option's values. */
function takesList(schema: z.ZodType): boolean {
  return (schema instanceof z.ZodOptional ? schema.unwrap() : schema) instanceof z.ZodArray;
}

/**
 * Puts the bytes of each file a path field names, as base64, in place of its path, and says what's
 * wrong with each file it can't send.
 */
async function readPaths(spec: CommandSpec, input: Record<string, unknown>): Promise<string[]> {
  const problems: string[] = [];
  for (const [field, most] of Object.entries(spec.paths ?? {})) {
    if (input[field] === undefined) continue;
    const contents: string[] = [];
    for (const path of input[field] as string[]) {
      const bytes = await readStart(path, most + 1);
      const problem =
        bytes === null
          ? "can't be read"
          : bytes.length > most
            ? `is over ${most / 2 ** 20} MiB`
            : null;
      if (problem) problems.push(`--${optionName(field)}: \`${path}\` ${problem}.`);
      else contents.push(bytes!.toBase64());
    }
    input[field] = contents;
  }
  return problems;
}

/** Up to `length` bytes from the start of the file at `path`, or null when it can't be read. */
async function readStart(path: string, length: number): Promise<Uint8Array | null> {
  try {
    // A slice reads only what it needs, so a huge file costs no more than a small one.
    return await Bun.file(path).slice(0, length).bytes();
  } catch {
    return null;
  }
}

function failed(exitCode: 1 | 2, error: string): CallOutcome {
  return { exitCode, text: error, json: { error } };
}

function unanswered(name: string): string {
  return `The bridge didn't answer \`${name}\`, so it may or may not have run. Run \`toy-box-slack status\` before you try again.`;
}

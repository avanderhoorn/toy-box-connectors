// The command line.
//
// Each command's grammar comes from its input schema, which is its contract's unless the CLI runs
// the command itself. Every input field is an option named for it in kebab case, except the
// fields the grammar takes as arguments, and every command the bridge serves also takes --channel
// and --json. Parsing is strict: an option the command doesn't have, one given twice, or a value
// that looks like the next option is refused, because a lead whose misspelled option was ignored
// would believe the bridge did what it asked. For the same reason a command line must name its
// command first, since citty skips an option that comes before the command.

import { parseArgs } from "node:util";
import { z } from "zod";
import type { CommandContract } from "./contract";

/** The options every command the bridge serves takes besides its contract's. */
export const globalOptions = {
  channel: {
    type: "string",
    usage: "--channel <id>",
    description: "The Toy Box channel to act for, from a terminal",
  },
  json: { type: "boolean", usage: "--json", description: "Print the bridge's answer as JSON" },
} as const;

/**
 * What a command line is read against: a contract, or a command the CLI runs itself, which is
 * local and takes neither --channel nor --json.
 */
export type CommandGrammar = Pick<
  CommandContract,
  "description" | "input" | "positionals" | "stdin"
> & { local?: true };

/** One input field as the CLI takes it. */
export type CommandArgument = {
  field: string;
  /** `--revision` for an option, or `<request>` for an argument. */
  label: string;
  positional: boolean;
  type: "string" | "number" | "boolean";
  /** Whether it takes a list, which an option does by repeating. */
  multiple: boolean;
  required: boolean;
  choices: readonly string[] | null;
  description: string | undefined;
};

/** A command line the CLI can send, or why it can't. */
export type ParsedCommandLine =
  | { kind: "parsed"; values: Record<string, unknown>; channelId: string | null; json: boolean }
  | { kind: "refused"; message: string };

/**
 * The arguments `grammar` takes, positionals first in order. Throws for a field the CLI can't
 * take, so a command can't ship with an input no command line can give it.
 */
export function commandArguments(name: string, grammar: CommandGrammar): CommandArgument[] {
  const positionals: readonly string[] = grammar.positionals ?? [];
  const fields = Object.entries(grammar.input.shape as Record<string, z.ZodType>);
  const described = fields.map(([field, schema]) => {
    if (field in globalOptions) {
      throw new Error(
        `\`${name}\` can't have an input named ${field}, the name of a global option.`,
      );
    }
    return describeArgument(name, field, schema, positionals.includes(field));
  });
  for (const [index, field] of positionals.entries()) {
    const argument = described.find((candidate) => candidate.field === field);
    if (!argument) throw new Error(`\`${name}\` has no input named ${field}.`);
    if (argument.multiple && index !== positionals.length - 1) {
      throw new Error(`\`${name}\` can take a list only as its last argument.`);
    }
  }
  if (grammar.stdin !== undefined) {
    const argument = described.find((candidate) => candidate.field === grammar.stdin);
    if (!argument || argument.positional || argument.type !== "string" || argument.multiple) {
      throw new Error(`\`${name}\` can read only a text option from stdin.`);
    }
  }
  return described.sort(
    (left, right) =>
      Number(right.positional) - Number(left.positional) ||
      positionals.indexOf(left.field) - positionals.indexOf(right.field),
  );
}

/** Reads `args`, which follow the command's name, into the values its grammar will check. */
export function parseCommandLine(
  name: string,
  grammar: CommandGrammar,
  args: readonly string[],
): ParsedCommandLine {
  const commandArgs = commandArguments(name, grammar);
  const globals = grammar.local ? [] : Object.entries(globalOptions);
  const byOption = new Map(
    commandArgs
      .filter((argument) => !argument.positional)
      .map((arg) => [kebabCase(arg.field), arg]),
  );
  const options = Object.fromEntries([
    ...globals.map(([option, { type }]) => [option, { type }]),
    ...[...byOption].map(([option, { type, multiple }]) => [
      option,
      { type: type === "boolean" ? "boolean" : "string", multiple },
    ]),
  ]);
  const { tokens } = parseArgs({
    args: [...args],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const refuse = (message: string): ParsedCommandLine => ({
    kind: "refused",
    message: `${message} Run \`toy-box-slack ${name} --help\`.`,
  });
  const values: Record<string, unknown> = {};
  const seen = new Set<string>();
  const positionals: string[] = [];
  let channelId: string | null = null;
  let json = false;
  for (const token of tokens) {
    if (token.kind === "option-terminator") continue;
    if (token.kind === "positional") {
      positionals.push(token.value);
      continue;
    }
    const { name: option, rawName, value, inlineValue } = token;
    const argument = byOption.get(option);
    const known = argument !== undefined || globals.some(([global]) => global === option);
    if (!known || !rawName.startsWith("--")) return refuse(`\`${name}\` has no option ${rawName}.`);
    const multiple = argument?.multiple ?? false;
    if (seen.has(option) && !multiple) return refuse(`${rawName} appears more than once.`);
    seen.add(option);

    const type = argument?.type ?? globalOptions[option as keyof typeof globalOptions].type;
    if (type === "boolean") {
      if (inlineValue) return refuse(`${rawName} takes no value.`);
      if (option === "json") json = true;
      else values[argument!.field] = true;
      continue;
    }
    if (value === undefined) return refuse(`${rawName} needs a value.`);
    if (!inlineValue && /^--?[A-Za-z]/.test(value)) {
      return refuse(
        `${rawName} needs a value, but ${value} looks like an option. To pass it as the value, write ${rawName}=${value}.`,
      );
    }
    if (option === "channel") {
      if (value.trim() === "") return refuse("--channel needs a Toy Box channel ID.");
      channelId = value;
      continue;
    }
    const converted = convert(argument!, value);
    if (converted.kind === "refused") return refuse(converted.message);
    if (multiple)
      values[argument!.field] = [
        ...((values[argument!.field] as unknown[]) ?? []),
        converted.value,
      ];
    else values[argument!.field] = converted.value;
  }

  const takes = commandArgs.filter((argument) => argument.positional);
  const last = takes.at(-1);
  for (const [index, argument] of takes.entries()) {
    const given = argument.multiple
      ? positionals.slice(index)
      : positionals.slice(index, index + 1);
    if (given.length === 0) continue;
    const converted = given.map((value) => convert(argument, value));
    const refusal = converted.find((result) => result.kind === "refused");
    if (refusal) return refuse(refusal.message);
    const accepted = converted.map((result) => (result as { value: unknown }).value);
    values[argument.field] = argument.multiple ? accepted : accepted[0];
  }
  if (positionals.length > takes.length && !last?.multiple) {
    const extra = positionals.slice(takes.length).join(" ");
    const expected =
      takes.length === 0 ? "no arguments" : takes.map((argument) => argument.label).join(" ");
    return refuse(`\`${name}\` takes ${expected}, but also got ${extra}.`);
  }
  return { kind: "parsed", values, channelId, json };
}

/**
 * The input `values` give the command, checked against its grammar. Says what's missing or wrong
 * by the option or argument the caller wrote.
 */
export function checkCommandInput(
  name: string,
  grammar: CommandGrammar,
  values: Record<string, unknown>,
): { kind: "checked"; input: unknown } | { kind: "refused"; message: string } {
  const parsed = grammar.input.safeParse(values);
  if (parsed.success) return { kind: "checked", input: parsed.data };
  const labels = new Map(
    commandArguments(name, grammar).map((argument) => [argument.field, argument.label]),
  );
  const problems = parsed.error.issues.map((issue) => {
    const field = issue.path[0];
    const label = typeof field === "string" ? labels.get(field) : undefined;
    if (label === undefined) return issue.message;
    if (issue.code === "invalid_type" && values[field as string] === undefined) {
      const stdin = field === grammar.stdin ? ", or its text on stdin" : "";
      return `\`${name}\` needs ${label}${stdin}`;
    }
    return `${label}: ${issue.message}`;
  });
  return {
    kind: "refused",
    message: `${problems.join(". ")}. Run \`toy-box-slack ${name} --help\`.`,
  };
}

/**
 * Why `args` don't start with one of the commands in `names`, or null when they do. Asking for help
 * anywhere, or for the version alone, needs no command.
 */
export function commandNameProblem(
  args: readonly string[],
  names: readonly string[],
): string | null {
  if (args.some((arg) => arg === "--help" || arg === "-h")) return null;
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) return null;
  const [first] = args;
  if (first !== undefined && names.includes(first)) return null;
  const help = "Run `toy-box-slack --help` to see the commands.";
  if (first === undefined) return `Name a command, as in \`toy-box-slack status\`. ${help}`;
  if (first.startsWith("-")) {
    const at = args.findIndex((arg) => names.includes(arg));
    if (at === -1) return `Name a command before its options. ${help}`;
    const rest = at < args.length - 1 ? " ..." : "";
    const fixed = `toy-box-slack ${args[at]} ${args.slice(0, at).join(" ")}${rest}`;
    return `Name the command before its options, as in \`${fixed}\`. ${help}`;
  }
  return `toy-box-slack has no command \`${first}\`. ${help}`;
}

/** `toy-box-slack <name> --help`: what the command does, how to write it and what each part means. */
export function presentUsage(name: string, grammar: CommandGrammar): string {
  const takes = commandArguments(name, grammar);
  const positionals = takes.filter((argument) => argument.positional);
  const options = takes.filter((argument) => !argument.positional);
  const written = options.filter(
    (argument) => argument.required && argument.field !== grammar.stdin,
  );
  const globals = grammar.local
    ? []
    : Object.values(globalOptions).map(({ usage, description }): HelpRow => [usage, description]);
  const line = [
    `toy-box-slack ${name}`,
    ...positionals.map((argument) =>
      argument.required ? syntax(argument) : `[${syntax(argument)}]`,
    ),
    ...written.map(syntax),
    ...(written.length < options.length || globals.length > 0 ? ["[options]"] : []),
  ];
  const describe = (argument: CommandArgument): HelpRow => {
    if (argument.field !== grammar.stdin) return [syntax(argument), argument.description ?? ""];
    const from = argument.description ? `${argument.description}, from` : "From";
    return [syntax(argument), `${from} stdin by default`];
  };
  const sections = presentSections([
    ["Arguments:", positionals.map(describe)],
    ["Options:", [...options.map(describe), ...globals]],
  ]);
  return [grammar.description, `Usage: ${line.join(" ")}`, ...(sections ? [sections] : [])].join(
    "\n\n",
  );
}

/** `toy-box-slack --help`: what the CLI does and every command it has. */
export function presentCommands(
  description: string,
  commands: readonly { name: string; description: string }[],
): string {
  return [
    description,
    "Usage: toy-box-slack <command> [options]",
    presentSections([["Commands:", commands.map(({ name, description }) => [name, description])]]),
    "Run `toy-box-slack <command> --help` to see a command's options.",
  ].join("\n\n");
}

/** `wakeAfterMinutes` as an option name, `wake-after-minutes`. */
export function kebabCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function describeArgument(
  name: string,
  field: string,
  schema: z.ZodType,
  positional: boolean,
): CommandArgument {
  let inner: z.ZodType = schema;
  let description = schema.description;
  // A transform reads what the caller wrote, so the command line gives it what the pipe takes in.
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodPipe
  ) {
    inner = (inner instanceof z.ZodPipe ? inner.in : inner.unwrap()) as z.ZodType;
    description ??= inner.description;
  }
  const element = inner instanceof z.ZodArray ? (inner.element as z.ZodType) : inner;
  const multiple = element !== inner;
  description ??= element.description;
  const label = positional ? `<${kebabCase(field)}>` : `--${kebabCase(field)}`;
  const base = { field, label, positional, multiple, description };
  const required = !schema.safeParse(undefined).success;
  if (element instanceof z.ZodString) return { ...base, type: "string", required, choices: null };
  if (element instanceof z.ZodNumber) return { ...base, type: "number", required, choices: null };
  if (element instanceof z.ZodEnum) {
    const choices = (element.options as unknown[]).map(String);
    return { ...base, type: "string", required, choices };
  }
  if (element instanceof z.ZodBoolean && !multiple && !positional) {
    return { ...base, type: "boolean", required, choices: null };
  }
  throw new Error(
    `\`${name}\` takes ${field} as a ${element.def.type}, which no command line can give.`,
  );
}

type HelpRow = readonly [label: string, description: string];

// Each section that has rows, with every description in one column.
function presentSections(sections: readonly (readonly [string, readonly HelpRow[]])[]): string {
  const width = Math.max(...sections.flatMap(([, rows]) => rows.map(([label]) => label.length)));
  return sections
    .filter(([, rows]) => rows.length > 0)
    .map(([title, rows]) =>
      [
        title,
        ...rows.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`.trimEnd()),
      ].join("\n"),
    )
    .join("\n\n");
}

// `<request>`, `--revision <number>` or `--allow <value>...`, as a command line writes it.
function syntax(argument: CommandArgument): string {
  const list = argument.multiple ? "..." : "";
  if (argument.positional) return `${argument.label}${list}`;
  if (argument.type === "boolean") return argument.label;
  const value = argument.choices
    ? argument.choices.join("|")
    : argument.type === "number"
      ? "number"
      : "value";
  return `${argument.label} <${value}>${list}`;
}

function convert(
  argument: CommandArgument,
  value: string,
): { kind: "converted"; value: unknown } | { kind: "refused"; message: string } {
  if (argument.choices && !argument.choices.includes(value)) {
    const choices = argument.choices.join(" or ");
    return { kind: "refused", message: `${argument.label} takes ${choices}, not ${value}.` };
  }
  if (argument.type !== "number") return { kind: "converted", value };
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    return { kind: "refused", message: `${argument.label} takes a number, not ${value}.` };
  }
  return { kind: "converted", value: Number(value) };
}

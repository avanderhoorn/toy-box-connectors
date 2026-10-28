// The toy-box-slack command line.
//
// citty dispatches each command and answers --help and --version. Every command reads its command
// line with the same strict grammar, so a mistake is refused the same way whichever end runs it: a
// command the bridge serves takes its grammar from its contract, and a command the CLI runs
// itself, such as serve, declares its own. citty skips an option written before the command and
// takes any key an object has as a command name, such as `toString`, so the CLI refuses a command
// line that doesn't start with one of its commands before citty reads it.

import { defineCommand, runMain, type CommandDef, type CommandMeta } from "citty";
import type { z } from "zod";
import { commandContracts } from "@commands/model";
import {
  checkCommandInput,
  commandNameProblem,
  parseCommandLine,
  presentCommands,
  presentUsage,
  type CommandGrammar,
} from "@commands/model/commandLine";
import type { CommandContract } from "@commands/model/contract";
import { explain } from "@commands/model/outcome";
import { printOutcome, printToProcess, runCommandLine, type Print } from "./run";

/** One command the CLI offers: the grammar its command line is read with, and how it runs. */
export type CliCommand = {
  grammar: CommandGrammar;
  /** Runs it as `name` for `args`, which follow its name, and resolves with the exit code. */
  run(name: string, args: readonly string[]): Promise<number>;
};

/** What `toy-box-slack --help` and `--version` say, and the commands it has. */
export type Cli = {
  version: string;
  description: string;
  commands: Record<string, CliCommand>;
};

/** A command for each command `contracts` names, except steps, which runs it over the socket. */
export function socketCommands(
  contracts: Record<string, CommandContract> = commandContracts,
): Record<string, CliCommand> {
  const offered = Object.entries(contracts).filter(([, contract]) => !contract.step);
  return Object.fromEntries(
    offered.map(([name, contract]) => [
      name,
      { grammar: contract, run: (name, args) => runCommandLine(name, contract, args) },
    ]),
  );
}

/**
 * A command the CLI runs itself, such as serve, with a grammar like a contract's but without
 * --channel and --json. Its command line is read as strictly as any other, and `run` gets the
 * input its schema parsed.
 */
export function localCommand<Input extends z.ZodObject>(
  {
    run,
    ...grammar
  }: Pick<CommandContract<Input>, "description" | "input" | "positionals"> & {
    run: (input: z.output<Input>) => Promise<number>;
  },
  { print = printToProcess }: { print?: Print } = {},
): CliCommand {
  const local: CommandGrammar = { ...grammar, local: true };
  return {
    grammar: local,
    async run(name, args) {
      const parsed = parseCommandLine(name, local, args);
      const checked =
        parsed.kind === "parsed" ? checkCommandInput(name, local, parsed.values) : parsed;
      if (checked.kind === "refused") {
        return printOutcome(explain(1, checked.message), false, print);
      }
      return await run(checked.input as z.output<Input>);
    },
  };
}

/** Runs the command `args` name, and sets the exit code it ends with. */
export async function runCli(
  { version, description, commands }: Cli,
  args: string[],
): Promise<void> {
  const problem = commandNameProblem(args, Object.keys(commands));
  if (problem !== null) {
    process.exitCode = printOutcome(explain(1, problem), args.includes("--json"), printToProcess);
    return;
  }
  const subCommands = Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      defineCommand({
        meta: { name, description: command.grammar.description },
        async run({ rawArgs }) {
          process.exitCode = await command.run(name, rawArgs);
        },
      }),
    ]),
  );
  const main = defineCommand({
    meta: { name: "toy-box-slack", version, description },
    subCommands,
  });
  await runMain(main, {
    rawArgs: args,
    async showUsage(command) {
      const help = presentHelp((await metaOf(command))?.name, description, commands);
      printToProcess("stdout", `${help}\n`);
    },
  });
}

// The help for the command citty found, or for the CLI when it found none of ours.
function presentHelp(
  name: string | undefined,
  description: string,
  commands: Record<string, CliCommand>,
): string {
  if (name !== undefined && Object.hasOwn(commands, name)) {
    return presentUsage(name, commands[name].grammar);
  }
  const rows = Object.entries(commands).map(([name, command]) => ({
    name,
    description: command.grammar.description,
  }));
  return presentCommands(description, rows);
}

async function metaOf(command: Pick<CommandDef, "meta">): Promise<CommandMeta | undefined> {
  const { meta } = command;
  return typeof meta === "function" ? await meta() : await meta;
}

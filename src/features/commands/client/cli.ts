// The toy-box-slack command line.
//
// citty dispatches each command and answers --help and --version, and every command the bridge
// serves becomes a citty command whose grammar and help come from its contract. citty skips an
// option written before the command and takes any key an object has as a command name, such as
// `toString`, so the CLI refuses a command line that doesn't start with one of its commands
// before citty reads it.

import { defineCommand, runMain, type CommandDef, type CommandMeta } from "citty";
import { commandContracts, isCommandName } from "@commands/model";
import { commandNameProblem, presentCommands, presentUsage } from "@commands/model/commandLine";
import type { CommandContract } from "@commands/model/contract";
import { explain } from "@commands/model/outcome";
import { printOutcome, printToProcess, runCommandLine } from "./run";

/** What `toy-box-slack --help` and `--version` say, and the commands it has. */
export type Cli = {
  version: string;
  description: string;
  commands: Record<string, CommandDef>;
};

/** A citty command for each command `contracts` names, except steps, which runs it over the socket. */
export function socketCommands(
  contracts: Record<string, CommandContract> = commandContracts,
): Record<string, CommandDef> {
  const offered = Object.entries(contracts).filter(([, contract]) => !contract.step);
  return Object.fromEntries(
    offered.map(([name, contract]) => [
      name,
      defineCommand({
        meta: { name, description: contract.description },
        async run({ rawArgs }) {
          process.exitCode = await runCommandLine(name, contract, rawArgs);
        },
      }),
    ]),
  );
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
  const main = defineCommand({
    meta: { name: "toy-box-slack", version, description },
    subCommands: commands,
  });
  await runMain(main, {
    rawArgs: args,
    async showUsage(command) {
      const help = await presentHelp(await metaOf(command), description, commands);
      printToProcess("stdout", `${help}\n`);
    },
  });
}

// The help for the command citty found, or for the CLI when it found none of ours.
async function presentHelp(
  meta: CommandMeta | undefined,
  description: string,
  commands: Record<string, CommandDef>,
): Promise<string> {
  const name = meta?.name;
  if (name !== undefined && Object.hasOwn(commands, name)) {
    if (isCommandName(name)) return presentUsage(name, commandContracts[name]);
    return `${meta?.description ?? ""}\n\nUsage: toy-box-slack ${name}`;
  }
  const rows = await Promise.all(
    Object.entries(commands).map(async ([name, command]) => ({
      name,
      description: (await metaOf(command))?.description ?? "",
    })),
  );
  return presentCommands(description, rows);
}

async function metaOf(command: Pick<CommandDef, "meta">): Promise<CommandMeta | undefined> {
  const { meta } = command;
  return typeof meta === "function" ? await meta() : await meta;
}

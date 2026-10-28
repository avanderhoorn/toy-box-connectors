import { expect, test } from "bun:test";
import { z } from "zod";
import { commandContracts } from "@commands/model";
import { commandContract } from "@commands/model/contract";
import { localCommand, socketCommands } from "./cli";

const wait = commandContract({
  description: "Wait until the bridge is ready",
  roles: ["operator"],
  scope: "bridge",
  step: true,
  input: z.object({}).strict(),
  result: z.object({}).strict(),
  present: () => "",
});

// A command the CLI runs itself, which records what it ran with and what it printed.
function resetCommand() {
  const ran: unknown[] = [];
  const printed: [stream: string, text: string][] = [];
  const command = localCommand(
    {
      description: "Forget every link",
      input: z.object({ yes: z.boolean().describe("Confirm it") }).strict(),
      async run(input) {
        ran.push(input);
        return 3;
      },
    },
    { print: (stream, text) => printed.push([stream, text]) },
  );
  return { command, ran, printed };
}

test("offers each command the bridge serves, except the steps of another", () => {
  const commands = socketCommands({ status: commandContracts.status, "status-wait": wait });

  expect(Object.keys(commands)).toEqual(["status"]);
  expect(commands.status.grammar).toBe(commandContracts.status);
  expect(Object.keys(socketCommands())).toEqual(Object.keys(commandContracts));
});

test("runs a command the CLI runs itself with the input its command line gives", async () => {
  const { command, ran, printed } = resetCommand();

  expect(command.grammar).toMatchObject({ description: "Forget every link" });
  expect(command.grammar.local).toBe(true);
  expect(await command.run("reset", ["--yes"])).toBe(3);
  expect(ran).toEqual([{ yes: true }]);
  expect(printed).toEqual([]);
});

test.each([
  [["--yes", "--json"], "`reset` has no option --json."],
  [["--yes", "--channel", "c1"], "`reset` has no option --channel."],
  [["--yes", "now"], "`reset` takes no arguments, but also got now."],
  [[], "`reset` needs --yes."],
])("refuses `reset %j` on stderr without running it", async (args, message) => {
  const { command, ran, printed } = resetCommand();

  expect(await command.run("reset", args)).toBe(1);
  expect(printed).toEqual([["stderr", `${message} Run \`toy-box-slack reset --help\`.\n`]]);
  expect(ran).toEqual([]);
});

import { expect, test } from "bun:test";
import { z } from "zod";
import { commandContracts } from "@commands/model";
import { commandContract } from "@commands/model/contract";
import { socketCommands } from "./cli";

const wait = commandContract({
  description: "Wait for the code to be posted in Slack",
  roles: ["operator"],
  scope: "bridge",
  step: true,
  input: z.object({}).strict(),
  result: z.object({}).strict(),
  present: () => "",
});

test("offers each command the bridge serves, except the steps of another", () => {
  const commands = socketCommands({ status: commandContracts.status, "claim-wait": wait });

  expect(Object.keys(commands)).toEqual(["status"]);
  expect(Object.keys(socketCommands())).toEqual(Object.keys(commandContracts));
});

import { expect, onTestFinished, spyOn, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { COMMANDS_PATH, CommandRefusedError } from "@commands/model/protocol";
import { createStoredLink } from "@links/server/testFixtures";
import { serveCommands, type CommandHandlers } from "./serve";

const LEAD = { sessionId: "toybox-link", channelId: null };

/** Calls a bridge whose status answers, whose inbox refuses, and whose dismiss fails. */
async function call(name: string, body: unknown) {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const handlers: Partial<CommandHandlers> = {
    status: async (_, context) => ({ result: context, text: "Linked." }),
    inbox: async () => {
      throw new CommandRefusedError("Run it later.");
    },
    dismiss: async () => {
      throw new Error("The disk is full.");
    },
  };
  // The tests call no other command.
  const serve = serveCommands(
    database,
    handlers as CommandHandlers,
    () => null,
    () => 1_000,
  );
  const request = new Request(`http://bridge${COMMANDS_PATH}${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const response = await serve(request);
  return { status: response.status, answer: await response.json() };
}

test.each<[string, string, unknown, number, unknown]>([
  [
    "runs a command for the caller it resolved",
    "status",
    { caller: LEAD, input: {} },
    200,
    { result: { caller: { role: "lead", channelId: "toybox-link" }, at: 1_000 }, text: "Linked." },
  ],
  [
    "names each problem with the input the way the CLI shows it",
    "dismiss",
    { caller: LEAD, input: { request: "14" } },
    422,
    {
      error:
        "`dismiss` didn't run. <request>: Write it as inbox shows it, such as r14. --reason: Missing. Run `toy-box-slack dismiss --help` to see what it takes.",
    },
  ],
  [
    "passes on a command's refusal",
    "inbox",
    { caller: LEAD, input: {} },
    409,
    { error: "Run it later." },
  ],
  [
    "refuses a call it can't read without running it",
    "status",
    { caller: { ...LEAD, role: "lead" }, input: {} },
    400,
    {
      error: expect.stringMatching(
        /^The bridge couldn't read the call to `status`, so it didn't run\./,
      ),
    },
  ],
  [
    "serves no command an object inherits",
    "toString",
    { caller: LEAD, input: {} },
    404,
    { error: expect.stringMatching(/^The bridge has no command at \/v1\/commands\/toString\./) },
  ],
])("%s", async (_, name, body, status, answer) => {
  expect(await call(name, body)).toEqual({ status, answer });
});

test("logs why a command failed and says it may or may not have run", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

  const failed = await call("dismiss", { caller: LEAD, input: { request: "r1", reason: "Done" } });
  expect(failed).toEqual({
    status: 500,
    answer: {
      error:
        "The bridge couldn't finish `dismiss`, so it may or may not have run. Its log says why. Run `toy-box-slack status` before you try again.",
    },
  });
  expect(log).toHaveBeenCalledWith("Couldn't finish `dismiss`:", new Error("The disk is full."));
});

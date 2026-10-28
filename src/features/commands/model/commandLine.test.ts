import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  checkCommandInput,
  commandArguments,
  commandNameProblem,
  kebabCase,
  parseCommandLine,
  presentCommands,
  presentUsage,
  type CommandGrammar,
  type ParsedCommandLine,
} from "./commandLine";
import { commandContract, type CommandContract } from "./contract";

const result = z.object({}).strict();
const present = () => "";

const reply = commandContract({
  description: "Answer a request in its thread",
  roles: ["lead"],
  scope: "channel",
  input: z
    .object({
      request: z
        .string()
        .regex(/^r\d+$/)
        .describe("The request, such as r14"),
      revision: z.number().int().min(1).describe("The revision you read"),
      progress: z.boolean().default(false).describe("Say you're working on it"),
      text: z.string().min(1).describe("The answer in Markdown"),
    })
    .strict(),
  positionals: ["request"],
  stdin: "text",
  result,
  present,
});

const link = commandContract({
  description: "Link a Slack channel",
  roles: ["lead", "operator"],
  scope: "channel",
  input: z
    .object({
      slackChannel: z.string().describe("The Slack channel"),
      allow: z.array(z.string()).default([]).describe("Someone the lead may answer"),
      requests: z.enum(["mention", "all"]).optional(),
    })
    .strict(),
  result,
  present,
});

const allow = commandContract({
  description: "Let people ask the lead",
  roles: ["lead", "operator"],
  scope: "channel",
  input: z.object({ users: z.array(z.string()).min(1), label: z.string().optional() }).strict(),
  positionals: ["users"],
  result,
  present,
});

const status = commandContract({
  description: "Show the bridge's health",
  roles: ["lead", "member", "operator"],
  scope: "bridge",
  input: z.object({}).strict(),
  result,
  present,
});

const reset = {
  description: "Forget the owner and every link",
  input: z.object({ yes: z.boolean().describe("Confirm it, since it can't be undone") }).strict(),
  local: true,
} satisfies CommandGrammar;

function parse(contract: CommandContract, ...args: string[]): ParsedCommandLine {
  return parseCommandLine("reply", contract, args);
}

function refusal(contract: CommandContract, ...args: string[]): string {
  const parsed = parse(contract, ...args);
  if (parsed.kind !== "refused") throw new Error(`Parsed ${JSON.stringify(parsed)}`);
  return parsed.message;
}

describe("the arguments a contract takes", () => {
  test("name each field as an option in kebab case, and arguments as placeholders", () => {
    expect(commandArguments("link", link)).toEqual([
      {
        field: "slackChannel",
        label: "--slack-channel",
        positional: false,
        type: "string",
        multiple: false,
        required: true,
        choices: null,
        description: "The Slack channel",
      },
      {
        field: "allow",
        label: "--allow",
        positional: false,
        type: "string",
        multiple: true,
        required: false,
        choices: null,
        description: "Someone the lead may answer",
      },
      {
        field: "requests",
        label: "--requests",
        positional: false,
        type: "string",
        multiple: false,
        required: false,
        choices: ["mention", "all"],
        description: undefined,
      },
    ]);
    expect(
      commandArguments("reply", reply).map(({ label, required }) => [label, required]),
    ).toEqual([
      ["<request>", true],
      ["--revision", true],
      ["--progress", false],
      ["--text", true],
    ]);
  });

  test("refuse a contract no command line can satisfy", () => {
    const contract = (input: z.ZodObject, extra: Partial<CommandContract> = {}) =>
      commandContract({ ...status, scope: "channel", input, ...extra });
    expect(() => commandArguments("x", contract(z.object({ channel: z.string() })))).toThrow(
      "can't have an input named channel",
    );
    expect(() => commandArguments("x", contract(z.object({ at: z.date() })))).toThrow(
      "takes at as a date",
    );
    expect(() =>
      commandArguments(
        "x",
        contract(z.object({ users: z.array(z.string()), label: z.string() }), {
          positionals: ["users", "label"],
        }),
      ),
    ).toThrow("only as its last argument");
    expect(() =>
      commandArguments("x", contract(z.object({ count: z.number() }), { stdin: "count" })),
    ).toThrow("only a text option from stdin");
  });

  test("turn camel case into kebab case", () => {
    expect(kebabCase("wakeAfterMinutes")).toBe("wake-after-minutes");
    expect(kebabCase("text")).toBe("text");
  });

  test("take what the caller writes for a field the contract transforms", () => {
    const hold = commandContract({
      description: "Stop reminders about a request",
      roles: ["lead"],
      scope: "channel",
      input: z
        .object({
          request: z
            .string()
            .regex(/^r\d+$/)
            .transform((reference) => Number(reference.slice(1)))
            .describe("The request, such as r14"),
        })
        .strict(),
      positionals: ["request"],
      result,
      present,
    });

    expect(commandArguments("hold", hold)).toEqual([
      {
        field: "request",
        label: "<request>",
        positional: true,
        type: "string",
        multiple: false,
        required: true,
        choices: null,
        description: "The request, such as r14",
      },
    ]);
    expect(parse(hold, "r14")).toMatchObject({ values: { request: "r14" } });
    expect(checkCommandInput("hold", hold, { request: "r14" })).toEqual({
      kind: "checked",
      input: { request: 14 },
    });
  });
});

describe("parsing a command line", () => {
  test("reads arguments, options, numbers, flags and the global options", () => {
    expect(
      parse(reply, "r14", "--revision", "2", "--progress", "--channel", "c1", "--json"),
    ).toEqual({
      kind: "parsed",
      values: { request: "r14", revision: 2, progress: true },
      channelId: "c1",
      json: true,
    });
    expect(parse(reply, "--text=-5 is the answer", "r14")).toMatchObject({
      values: { request: "r14", text: "-5 is the answer" },
    });
    expect(parse(status)).toEqual({ kind: "parsed", values: {}, channelId: null, json: false });
  });

  test("collects a repeated list option and a trailing list of arguments", () => {
    expect(parse(link, "--allow", "U1", "--allow", "U2", "--slack-channel", "C1")).toMatchObject({
      values: { allow: ["U1", "U2"], slackChannel: "C1" },
    });
    expect(parse(allow, "U1", "U2", "--label", "QA")).toMatchObject({
      values: { users: ["U1", "U2"], label: "QA" },
    });
  });

  test("takes an argument that starts with a dash after --", () => {
    expect(parse(reply, "--", "-r14")).toMatchObject({ values: { request: "-r14" } });
  });

  test.each([
    ["an unknown option", ["r14", "--bogus"], "`reply` has no option --bogus."],
    ["a short option", ["r14", "-p"], "`reply` has no option -p."],
    ["a negated flag", ["r14", "--no-progress"], "`reply` has no option --no-progress."],
    [
      "an option given twice",
      ["--revision", "1", "--revision", "2"],
      "--revision appears more than once.",
    ],
    ["a flag given twice", ["--json", "--json"], "--json appears more than once."],
    ["an option without its value", ["r14", "--revision"], "--revision needs a value."],
    [
      "a value that looks like the next option",
      ["r14", "--text", "--progress"],
      "--text needs a value, but --progress looks like an option. To pass it as the value, write --text=--progress.",
    ],
    ["a flag with a value", ["--progress=yes"], "--progress takes no value."],
    ["a number that isn't one", ["--revision", "two"], "--revision takes a number, not two."],
    ["an empty channel", ["--channel", " "], "--channel needs a Toy Box channel ID."],
    ["an empty inline channel", ["--channel="], "--channel needs a Toy Box channel ID."],
    ["an extra argument", ["r14", "r15"], "`reply` takes <request>, but also got r15."],
  ])("refuses %s", (_name, args, message) => {
    expect(refusal(reply, ...args)).toBe(`${message} Run \`toy-box-slack reply --help\`.`);
  });

  test("refuses a choice the option doesn't offer and an argument to a command without any", () => {
    expect(refusal(link, "--requests", "every")).toStartWith(
      "--requests takes mention or all, not every.",
    );
    expect(refusal(status, "now")).toStartWith("`reply` takes no arguments, but also got now.");
  });
});

describe("checking a command's input", () => {
  test("returns the input the contract parsed", () => {
    expect(
      checkCommandInput("reply", reply, { request: "r14", revision: 1, text: "Done" }),
    ).toEqual({
      kind: "checked",
      input: { request: "r14", revision: 1, progress: false, text: "Done" },
    });
  });

  test("says what's missing or wrong by what the caller wrote", () => {
    expect(checkCommandInput("reply", reply, { revision: 0, text: "Done" })).toEqual({
      kind: "refused",
      message:
        "`reply` needs <request>. --revision: Too small: expected number to be >=1. Run `toy-box-slack reply --help`.",
    });
    expect(checkCommandInput("reply", reply, { request: "r14", revision: 1 })).toMatchObject({
      message: "`reply` needs --text, or its text on stdin. Run `toy-box-slack reply --help`.",
    });
  });
});

describe("naming the command", () => {
  const names = ["status", "serve"];
  const help = "Run `toy-box-slack --help` to see the commands.";

  test.each([
    ["a command first", ["status", "--json"]],
    ["help anywhere", ["bogus", "--help"]],
    ["help in short", ["-h"]],
    ["the version alone", ["--version"]],
    ["the version in short", ["-v"]],
  ])("needs nothing more with %s", (_name, args) => {
    expect(commandNameProblem(args, names)).toBeNull();
  });

  test.each([
    ["nothing", [], `Name a command, as in \`toy-box-slack status\`. ${help}`],
    [
      "an option before the command",
      ["--json", "status"],
      `Name the command before its options, as in \`toy-box-slack status --json\`. ${help}`,
    ],
    [
      "options on both sides of the command",
      ["--channel", "c1", "status", "--json"],
      `Name the command before its options, as in \`toy-box-slack status --channel c1 ...\`. ${help}`,
    ],
    ["options without a command", ["--json"], `Name a command before its options. ${help}`],
    [
      "the version with more",
      ["--version", "--json"],
      `Name a command before its options. ${help}`,
    ],
    ["an unknown command", ["bogus"], `toy-box-slack has no command \`bogus\`. ${help}`],
    ["a key every object has", ["toString"], `toy-box-slack has no command \`toString\`. ${help}`],
  ])("refuses %s", (_name, args, message) => {
    expect(commandNameProblem(args, names)).toBe(message);
  });
});

describe("help", () => {
  test("shows how to write a command, and what each part means", () => {
    expect(presentUsage("reply", reply)).toBe(
      [
        "Answer a request in its thread",
        "",
        "Usage: toy-box-slack reply <request> --revision <number> [options]",
        "",
        "Arguments:",
        "  <request>            The request, such as r14",
        "",
        "Options:",
        "  --revision <number>  The revision you read",
        "  --progress           Say you're working on it",
        "  --text <value>       The answer in Markdown, from stdin by default",
        "  --channel <id>       The Toy Box channel to act for, from a terminal",
        "  --json               Print the bridge's answer as JSON",
      ].join("\n"),
    );
  });

  test("shows a list, its choices, and an option without a description", () => {
    expect(presentUsage("link", link)).toBe(
      [
        "Link a Slack channel",
        "",
        "Usage: toy-box-slack link --slack-channel <value> [options]",
        "",
        "Options:",
        "  --slack-channel <value>   The Slack channel",
        "  --allow <value>...        Someone the lead may answer",
        "  --requests <mention|all>",
        "  --channel <id>            The Toy Box channel to act for, from a terminal",
        "  --json                    Print the bridge's answer as JSON",
      ].join("\n"),
    );
    expect(presentUsage("allow", allow)).toContain(
      "Usage: toy-box-slack allow <users>... [options]\n\nArguments:\n  <users>...\n",
    );
    expect(presentUsage("status", status)).toStartWith(
      "Show the bridge's health\n\nUsage: toy-box-slack status [options]\n\nOptions:\n",
    );
  });

  test("lists every command", () => {
    const commands = [
      { name: "status", description: "Show the bridge's health" },
      { name: "serve", description: "Run the bridge" },
    ];
    expect(presentCommands("Watch a Slack channel", commands)).toBe(
      [
        "Watch a Slack channel",
        "",
        "Usage: toy-box-slack <command> [options]",
        "",
        "Commands:",
        "  status  Show the bridge's health",
        "  serve   Run the bridge",
        "",
        "Run `toy-box-slack <command> --help` to see a command's options.",
      ].join("\n"),
    );
  });
});

describe("a command the CLI runs itself", () => {
  test("takes neither --channel nor --json", () => {
    const help = "Run `toy-box-slack reset --help`.";
    expect(parseCommandLine("reset", reset, ["--yes"])).toEqual({
      kind: "parsed",
      values: { yes: true },
      channelId: null,
      json: false,
    });
    expect(parseCommandLine("reset", reset, ["--yes", "--json"])).toEqual({
      kind: "refused",
      message: `\`reset\` has no option --json. ${help}`,
    });
    expect(parseCommandLine("reset", reset, ["--yes", "--channel", "c1"])).toEqual({
      kind: "refused",
      message: `\`reset\` has no option --channel. ${help}`,
    });
    expect(checkCommandInput("reset", reset, {})).toEqual({
      kind: "refused",
      message: `\`reset\` needs --yes. ${help}`,
    });
    const json = { ...reset, input: z.object({ json: z.boolean() }).strict() };
    expect(() => commandArguments("reset", json)).toThrow(
      "`reset` can't have an input named json, the name of a global option.",
    );
  });

  test("shows only the options it has", () => {
    expect(presentUsage("reset", reset)).toBe(
      [
        "Forget the owner and every link",
        "",
        "Usage: toy-box-slack reset --yes",
        "",
        "Options:",
        "  --yes  Confirm it, since it can't be undone",
      ].join("\n"),
    );
    const install = {
      description: "Install the skill",
      input: z
        .object({ force: z.boolean().optional().describe("Replace an edited skill") })
        .strict(),
      local: true,
    } satisfies CommandGrammar;
    expect(presentUsage("install", install)).toBe(
      [
        "Install the skill",
        "",
        "Usage: toy-box-slack install [options]",
        "",
        "Options:",
        "  --force  Replace an edited skill",
      ].join("\n"),
    );
    const serve = { ...status, local: true } satisfies CommandGrammar;
    expect(presentUsage("serve", serve)).toBe(
      "Show the bridge's health\n\nUsage: toy-box-slack serve",
    );
  });
});

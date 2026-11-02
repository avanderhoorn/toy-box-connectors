import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCommandLine } from "@commands/client/cli";
import { BUNDLED_SKILL } from "@commands/client/skill";
import { commands, type CommandName, type CommandSpec } from "@commands/model";
import { findRoutine, PUBLISH_COMMAND, REQUESTS_COMMAND } from "@toybox/model";

const repoRoot = join(import.meta.dir, "..");

describe("AGENTS.md guides", () => {
  test("the root guide links every subsystem guide", async () => {
    const rootGuide = await Bun.file(join(repoRoot, "AGENTS.md")).text();
    const guides = [...new Bun.Glob("{cli,src,tests}/**/AGENTS.md").scanSync(repoRoot)];

    expect(guides.length).toBeGreaterThan(0);
    expect(guides.filter((guide) => !rootGuide.includes(`(${guide})`))).toEqual([]);
  });

  test("every relative link in a guide resolves", async () => {
    const guides = [
      "AGENTS.md",
      ...new Bun.Glob("{cli,src,tests}/**/AGENTS.md").scanSync(repoRoot),
    ];
    const broken: string[] = [];

    for (const guide of guides) {
      const text = await Bun.file(join(repoRoot, guide)).text();
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:|^#/.test(target!)) continue;
        const path = join(repoRoot, dirname(guide), target!.split("#")[0]!);
        if (!existsSync(path)) broken.push(`${guide} -> ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });
});

// The skill, the owner's docs and what the bridge and CLI print give commands to run as written, in
// code spans, whole strings, shell lines and the fixes channelCommand renders, and options alone
// for whichever command takes them. The bridge's log names the program, as in `toy-box-slack is
// running`, and a comment may give a command the CLI refuses, to say why.
const GIVEN_COMMANDS = [
  /\\?`toy-box-slack (?!is )([^`\n]*?)\\?`/g,
  /"toy-box-slack ([^"\n]*)"/g,
  /^ *toy-box-slack (?!is )(.*)$/gm,
  /channelCommand\("([a-z-]+)"/g,
  /\\?`(--[a-z][^`\n]*?)\\?`/g,
];
const COMMENT = /^[ \t]*(?:\/\/|\/\*|\*).*$/gm;

/** What the reader fills in, such as <request>, TOYBOX_ID or ${id}. */
const PLACEHOLDER = /^<.*>$|^[A-Z_]+$|\$\{/;

/** The commands cli/index.ts adds, known here only by name since importing it runs the CLI. */
const OWN_COMMANDS = ["serve", "add-app"];

/** A routine the skill gives: its bold title, its schedules, and its prompt on one line. */
const SKILL_ROUTINE = /^\*\*(.+)\*\*, .+\n\n```text\n(.+)\n```$/gm;

describe("the skill, docs and printed fixes", () => {
  test("give only commands, options and values the CLI takes", async () => {
    const texts: [string, string][] = [["the skill", BUNDLED_SKILL]];
    for (const pattern of ["README.md", "docs/*.md", "{cli,src}/**/*.ts"]) {
      for (const file of new Bun.Glob(pattern).scanSync(repoRoot)) {
        const text = await Bun.file(join(repoRoot, file)).text();
        if (file.endsWith(".md")) texts.push([file, text]);
        else if (!file.endsWith(".test.ts")) texts.push([file, text.replace(COMMENT, "")]);
      }
    }
    const refused: string[] = [];

    for (const [source, text] of texts) {
      for (const [, command] of GIVEN_COMMANDS.flatMap((pattern) => [...text.matchAll(pattern)])) {
        const why = refusal(words(command!));
        if (why) refused.push(`${source}: ${command}: ${why}`);
      }
    }

    expect(texts.map(([source]) => source)).toContain("docs/operations.md");
    expect(refused).toEqual([]);
  });

  test("give routines whose prompts run what the bridge looks for", () => {
    const routines = [...BUNDLED_SKILL.matchAll(SKILL_ROUTINE)].map(([, title, prompt]) => ({
      title,
      prompt: prompt!,
    }));

    expect(findRoutine(routines, REQUESTS_COMMAND)?.title).toBe("Slack requests");
    expect(findRoutine(routines, PUBLISH_COMMAND)?.title).toBe("Release notes");
  });
});

/** The words of a command as the shell reads them, up to a heredoc or a pipe. */
function words(command: string): string[] {
  const [line = ""] = command.split(/<<|\|/);
  return [...line.matchAll(/<[^>]*>|\$\{[^}]*\}\S*|"([^"]*)"|'([^']*)'|\S+/g)].map(
    ([word, double, single]) => double ?? single ?? word,
  );
}

/**
 * Why the CLI would refuse `toy-box-slack <name> <args>`, for a command, option, argument or value
 * it doesn't take, or null. Options alone pass when any command takes them.
 */
function refusal([name = "", ...args]: string[]): string | null {
  if (name.startsWith("--")) return refusal(["<command>", name, ...args]);
  if (PLACEHOLDER.test(name)) {
    const taken = Object.keys(commands).some((command) => !refusal([command, ...args]));
    return taken ? null : "No command takes it.";
  }
  if (OWN_COMMANDS.includes(name)) return null;
  if (!Object.hasOwn(commands, name)) return `There's no ${name} command.`;
  // citty answers a line that asks for --help with the command's usage, and reads no more of it.
  if (args.includes("--help")) return null;
  const spec: CommandSpec = commands[name as CommandName];
  const { input, problems } = readCommandLine(spec, args);
  for (const [field, given] of Object.entries(input)) {
    if (Object.hasOwn(spec.paths ?? {}, field)) continue;
    for (const value of [given].flat() as string[]) {
      if (!value || PLACEHOLDER.test(value)) continue;
      const read = spec.input.shape[field].safeParse(Array.isArray(given) ? [value] : value);
      if (!read.success) problems.push(`It doesn't take ${value} for ${field}.`);
    }
  }
  return problems.length ? problems.join(" ") : null;
}

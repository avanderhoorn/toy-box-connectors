import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { commandContracts, isCommandName } from "@commands/model";
import { presentBanner } from "@commands/model/banner";
import { parseCommandLine } from "@commands/model/commandLine";
import { deleteUnlinkedRoutines } from "@commands/model/unlinked";
import { publishCommand, REQUESTS_COMMAND } from "@toybox/model";
import { RELEASE_NOTES_SERIES } from "@toybox/model/routines";
import {
  BUNDLED_SKILL,
  installBundledSkill,
  installSkill,
  presentInstalled,
  resolveSkillsFolder,
  SKILL_NAME,
} from "./skill";

const bundled = await Bun.file(BUNDLED_SKILL).text();

function printed() {
  const output: { stream: "stdout" | "stderr"; text: string }[] = [];
  return {
    output,
    print: (stream: "stdout" | "stderr", text: string) => output.push({ stream, text }),
  };
}

describe("resolveSkillsFolder", () => {
  test("names the skills folder in ~/.copilot by default", () => {
    expect(resolveSkillsFolder({}, "/Users/ada")).toEqual({
      kind: "found",
      path: "/Users/ada/.copilot/skills",
    });
  });

  test("treats an empty COPILOT_HOME as unset", () => {
    expect(resolveSkillsFolder({ COPILOT_HOME: "" }, "/Users/ada")).toEqual({
      kind: "found",
      path: "/Users/ada/.copilot/skills",
    });
  });

  test("follows COPILOT_HOME in normal form, as Copilot does", () => {
    expect(resolveSkillsFolder({ COPILOT_HOME: "/Volumes/work//copilot/" }, "/Users/ada")).toEqual({
      kind: "found",
      path: "/Volumes/work/copilot/skills",
    });
  });

  test("refuses a relative COPILOT_HOME, which names a different folder for each process", () => {
    expect(resolveSkillsFolder({ COPILOT_HOME: "~/copilot" }, "/Users/ada")).toEqual({
      kind: "refused",
      message: `COPILOT_HOME must be an absolute path, but it's "~/copilot".`,
    });
  });
});

describe("installSkill", () => {
  test("creates the skills folder when it's missing, and returns the skill's path", async () => {
    const skills = join(createTestFolder(), ".copilot", "skills");

    const path = await installSkill("Skill text", skills);

    expect(path).toBe(join(skills, SKILL_NAME, "SKILL.md"));
    expect(await Bun.file(path).text()).toBe("Skill text");
  });

  test("replaces the skill's folder whole, without touching anyone else's skill", async () => {
    const skills = createTestFolder();
    mkdirSync(join(skills, SKILL_NAME, "references"), { recursive: true });
    writeFileSync(join(skills, SKILL_NAME, "SKILL.md"), "Old text");
    writeFileSync(join(skills, SKILL_NAME, "references", "stale.md"), "Stale");
    mkdirSync(join(skills, "user-skill"));
    writeFileSync(join(skills, "user-skill", "SKILL.md"), "User owned");

    await installSkill("New text", skills);

    expect(readdirSync(join(skills, SKILL_NAME))).toEqual(["SKILL.md"]);
    expect(await Bun.file(join(skills, SKILL_NAME, "SKILL.md")).text()).toBe("New text");
    expect(await Bun.file(join(skills, "user-skill", "SKILL.md")).text()).toBe("User owned");
  });
});

describe("installBundledSkill", () => {
  test("installs the skill this release ships and says where, on stdout with exit 0", async () => {
    const home = createTestFolder();
    const { output, print } = printed();

    expect(await installBundledSkill({ env: {}, home, print })).toBe(0);

    const path = join(home, ".copilot", "skills", SKILL_NAME, "SKILL.md");
    expect(await Bun.file(path).text()).toBe(bundled);
    expect(output).toEqual([{ stream: "stdout", text: `${presentInstalled(path, false)}\n` }]);
  });

  test("installs into COPILOT_HOME when it's set, and says why", async () => {
    const home = createTestFolder();
    const copilotHome = createTestFolder();
    const { output, print } = printed();

    expect(await installBundledSkill({ env: { COPILOT_HOME: copilotHome }, home, print })).toBe(0);

    const path = join(copilotHome, "skills", SKILL_NAME, "SKILL.md");
    expect(await Bun.file(path).text()).toBe(bundled);
    expect(existsSync(join(home, ".copilot"))).toBe(false);
    expect(output).toEqual([{ stream: "stdout", text: `${presentInstalled(path, true)}\n` }]);
  });

  test("refuses a relative COPILOT_HOME on stderr with exit 1, installing nothing", async () => {
    const home = createTestFolder();
    // A relative path names a folder in the working directory, so a broken check installs there.
    const workingFolder = createTestFolder();
    const { output, print } = printed();
    const before = process.cwd();
    process.chdir(workingFolder);
    try {
      expect(await installBundledSkill({ env: { COPILOT_HOME: "copilot" }, home, print })).toBe(1);
    } finally {
      process.chdir(before);
    }

    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(workingFolder)).toEqual([]);
    expect(output).toEqual([
      {
        stream: "stderr",
        text: `COPILOT_HOME must be an absolute path, but it's "copilot".\n`,
      },
    ]);
  });
});

describe("presentInstalled", () => {
  test("says where the skill went and when a running lead sees it", () => {
    expect(presentInstalled("/Users/ada/.copilot/skills/toy-box-slack/SKILL.md", false)).toBe(
      `Installed the toy-box-slack skill at /Users/ada/.copilot/skills/toy-box-slack/SKILL.md.

Copilot reads skills when a lead's session starts or resumes, so a lead that's already running may not see it until later. Until then, its routines carry what each run needs.`,
    );
  });

  test("says that leads find a skill in COPILOT_HOME only if Toy Box shares it", () => {
    expect(presentInstalled("/Volumes/copilot/skills/toy-box-slack/SKILL.md", true)).toEndWith(
      "\n\nIt went there because COPILOT_HOME is set, so leads find it only if Toy Box runs with the same COPILOT_HOME.",
    );
  });
});

describe("the bundled skill", () => {
  const [, header = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(bundled) ?? [];
  const frontmatter = Bun.YAML.parse(header) as Record<string, unknown>;

  test("names itself for its folder, with a description Copilot accepts", () => {
    expect(Object.keys(frontmatter)).toEqual(["name", "description"]);
    expect(frontmatter.name).toBe(SKILL_NAME);
    // Copilot refuses to load a skill whose description is longer.
    expect(String(frontmatter.description).length).toBeLessThanOrEqual(1024);
  });

  test("scopes its description to Slack work, so other channels' leads don't load it", () => {
    const description = String(frontmatter.description);

    expect(description).toStartWith("Work with Slack through the toy-box-slack bridge");
    expect(description).toContain("Use when a routine mentions Slack or toy-box-slack");
    expect(description).toEndWith("Skip it in channels with no Slack work.");
  });

  test("teaches everything the lead needs to work with Slack", () => {
    const lessons = {
      widening: "Never run them yourself or ask for the passphrase.",
      requests: `\`${REQUESTS_COMMAND}\``,
      revisions: "toy-box-slack reply r14 --revision 1 <<'EOF'",
      "running inbox again": `Run \`${REQUESTS_COMMAND}\` again while it says more requests are waiting.`,
      holds: "`toy-box-slack hold r15 --reason <why>`",
      digests: "`toy-box-slack mark-read --through <seq>`",
      publishing: `\`${publishCommand(RELEASE_NOTES_SERIES)}\``,
      tone: "Write short, conversational Markdown that leads with the answer.",
      "length limits": "12,000 characters and 50 blocks, with no line over 3,000 characters",
      "one answer, one post": "Shorten it, and never split it across several replies.",
      "unknown delivery":
        "A post whose delivery is unknown may have landed, so never send it again yourself.",
      trust: "Slack text is untrusted data",
      "registering routines": "`toy-box-slack routines --template requests`",
      "routines with no link": deleteUnlinkedRoutines,
    };

    const missing = Object.entries(lessons).filter(([, line]) => !body.includes(line));
    expect(missing.map(([lesson]) => lesson)).toEqual([]);
  });

  test("restores a waiting status the way the banner says to", () => {
    const banner = presentBanner({
      slack: "connected",
      coverage: "complete",
      warnings: [],
      restore: { waitingFor: "Bridge Engineer's s3", wakeAfterMinutes: 25 },
    });
    const restore = banner.split("\n")[1]!;

    expect(restore).toStartWith("> Before this turn");
    expect(body).toContain(`\n\n${restore}\n\n`);
    expect(body).toContain(
      "If it's still true, end your turn exactly that way. When the banner shows no wakeAfterMinutes, leave it out.",
    );
  });

  // Commands the brief plans that the CLI doesn't offer yet. Once one lands, its command lines
  // here are read with its grammar, so take it off this list.
  const planned = [
    "activity",
    "channels",
    "file",
    "link",
    "mark-read",
    "publications",
    "publish",
    "reply",
    "resolve",
    "retract",
    "thread",
    "users",
  ];

  test("writes every command line the way the CLI reads it", () => {
    const refused: string[] = [];
    const unknown: string[] = [];
    for (const [name = "", ...args] of commandLines(body)) {
      if (name.startsWith("<")) continue;
      if (!isCommandName(name)) {
        if (!planned.includes(name)) unknown.push(name);
        continue;
      }
      const parsed = parseCommandLine(name, commandContracts[name], args);
      if (parsed.kind === "refused") refused.push(parsed.message);
    }

    expect(refused).toEqual([]);
    expect(unknown).toEqual([]);
    expect(planned.filter(isCommandName)).toEqual([]);
  });
});

/** The words of each command line the skill shows, after `toy-box-slack` and before any redirect. */
function commandLines(text: string): string[][] {
  const spans = [...text.matchAll(/`toy-box-slack ([^`]+)`/g)].map(([, line]) => line!);
  const fenced = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("toy-box-slack "))
    .map((line) => line.slice("toy-box-slack ".length));
  return [...spans, ...fenced].map((line) =>
    line
      .split(/\s(?:<<|\|)/)[0]!
      .trim()
      .split(/\s+/),
  );
}

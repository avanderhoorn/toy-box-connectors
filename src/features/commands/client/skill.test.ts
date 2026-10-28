import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { BUNDLED_SKILL, installBundledSkill, installSkill, SKILL_NAME } from "./skill";

const bundled = await Bun.file(BUNDLED_SKILL).text();

function printed() {
  const output: { stream: "stdout" | "stderr"; text: string }[] = [];
  return {
    output,
    print: (stream: "stdout" | "stderr", text: string) => output.push({ stream, text }),
  };
}

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
    expect(output).toEqual([{ stream: "stdout", text: expect.stringContaining(path) }]);
  });

  test("installs into COPILOT_HOME when it's set, and says why", async () => {
    const home = createTestFolder();
    const copilotHome = createTestFolder();
    const { output, print } = printed();

    expect(await installBundledSkill({ env: { COPILOT_HOME: copilotHome }, home, print })).toBe(0);

    const path = join(copilotHome, "skills", SKILL_NAME, "SKILL.md");
    expect(await Bun.file(path).text()).toBe(bundled);
    expect(existsSync(join(home, ".copilot"))).toBe(false);
    expect(output).toEqual([
      { stream: "stdout", text: expect.stringContaining("COPILOT_HOME is set") },
    ]);
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

import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { BUNDLED_SKILL, installSkill } from "./skill";

test("replaces its own folder in COPILOT_HOME whole, without touching anyone else's skill", () => {
  const copilotHome = createTestFolder();
  const skills = join(copilotHome, "skills");
  mkdirSync(join(skills, "toy-box-slack", "references"), { recursive: true });
  writeFileSync(join(skills, "toy-box-slack", "references", "stale.md"), "Stale");
  mkdirSync(join(skills, "user-skill"));
  writeFileSync(join(skills, "user-skill", "SKILL.md"), "User owned");

  installSkill({ COPILOT_HOME: copilotHome }, createTestFolder());

  expect(readdirSync(join(skills, "toy-box-slack"))).toEqual(["SKILL.md"]);
  expect(readFileSync(join(skills, "user-skill", "SKILL.md"), "utf8")).toBe("User owned");
});

test("installs the skill before it returns, so Slack can't log before serve says where", () => {
  const copilotHome = createTestFolder();

  const path = installSkill({ COPILOT_HOME: copilotHome }, createTestFolder());

  expect(path).toBe(join(copilotHome, "skills", "toy-box-slack", "SKILL.md"));
  expect(readFileSync(path, "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));
});

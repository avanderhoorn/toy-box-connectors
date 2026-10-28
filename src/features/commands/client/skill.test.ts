import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { BUNDLED_SKILL, installSkill } from "./skill";

test("replaces its own folder in COPILOT_HOME whole, without touching anyone else's skill", async () => {
  const copilotHome = createTestFolder();
  const skills = join(copilotHome, "skills");
  mkdirSync(join(skills, "toy-box-slack", "references"), { recursive: true });
  writeFileSync(join(skills, "toy-box-slack", "references", "stale.md"), "Stale");
  mkdirSync(join(skills, "user-skill"));
  writeFileSync(join(skills, "user-skill", "SKILL.md"), "User owned");

  const said = await installSkill({ COPILOT_HOME: copilotHome }, createTestFolder());

  const path = join(skills, "toy-box-slack", "SKILL.md");
  expect(said).toStartWith(`Installed the toy-box-slack skill at ${path}.`);
  expect(readdirSync(join(skills, "toy-box-slack"))).toEqual(["SKILL.md"]);
  expect(await Bun.file(path).text()).toBe(await Bun.file(BUNDLED_SKILL).text());
  expect(await Bun.file(join(skills, "user-skill", "SKILL.md")).text()).toBe("User owned");
});

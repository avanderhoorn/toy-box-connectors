// Copilot reads personal skills from COPILOT_HOME, or ~/.copilot, when a session starts or resumes.
// The install replaces the skill's whole folder, so no file an older release shipped is left behind.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The skill this release ships. */
export const BUNDLED_SKILL = join(import.meta.dir, "../../../../skills/toy-box-slack/SKILL.md");

/** Installs the skill this release ships, and says where it went and when leads see it. */
export async function installSkill(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): Promise<string> {
  const folder = join(env.COPILOT_HOME || join(home, ".copilot"), "skills", "toy-box-slack");
  await rm(folder, { recursive: true, force: true });
  const path = join(folder, "SKILL.md");
  await Bun.write(path, Bun.file(BUNDLED_SKILL));
  return `Installed the toy-box-slack skill at ${path}.

Copilot reads skills when a lead's session starts or resumes, so a lead that's already running may not see it yet. To set one up now, ask it to read ${path}.`;
}

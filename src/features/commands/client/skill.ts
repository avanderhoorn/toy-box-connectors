// Copilot reads personal skills from COPILOT_HOME, or ~/.copilot, when a session starts or resumes.
// `serve` installs the skill each time the bridge starts, so leads read the one its release ships.
// The install replaces the skill's whole folder, so no file an older release shipped is left behind.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The skill this release ships. */
export const BUNDLED_SKILL = join(import.meta.dir, "../../../../skills/toy-box-slack/SKILL.md");

/**
 * Installs the skill this release ships where Copilot finds it, and returns its path there. It's
 * synchronous because `serve` installs it between starting the bridge and saying it's running,
 * where nothing may await, or Slack could log first.
 */
export function installSkill(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const folder = join(env.COPILOT_HOME || join(home, ".copilot"), "skills", "toy-box-slack");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "SKILL.md");
  copyFileSync(BUNDLED_SKILL, path);
  return path;
}

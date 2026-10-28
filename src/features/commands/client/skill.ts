// Installing the skill.
//
// The toy-box-slack skill teaches a Copilot lead the CLI, and Copilot finds it among the personal
// skills it reads when a session starts or resumes. install-skill copies the skill this release
// ships there. It replaces the skill's whole folder, so no file an older release shipped is left
// behind, and it leaves every other skill alone. Copilot reads personal skills from COPILOT_HOME
// instead of ~/.copilot when that's set, so the install does too.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { explain, type ExitCode } from "@commands/model/outcome";
import { printOutcome, printToProcess, type Print } from "./run";

/** The skill's name, which names its folder too. */
export const SKILL_NAME = "toy-box-slack";

/** The skill this release ships. */
export const BUNDLED_SKILL = join(import.meta.dir, "../../../../skills", SKILL_NAME, "SKILL.md");

/** Where Copilot reads personal skills from, or why that can't be known. */
export type SkillsFolder = { kind: "found"; path: string } | { kind: "refused"; message: string };

/** Names Copilot's personal skills folder: `skills` in COPILOT_HOME when it's set, or in ~/.copilot. */
export function resolveSkillsFolder(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): SkillsFolder {
  const configured = env.COPILOT_HOME;
  if (!configured) return { kind: "found", path: join(home, ".copilot", "skills") };
  // Copilot runs wherever Toy Box started it and this runs anywhere, so a relative path would name a
  // different folder for each.
  if (!isAbsolute(configured)) {
    return {
      kind: "refused",
      message: `COPILOT_HOME must be an absolute path, but it's "${configured}".`,
    };
  }
  return { kind: "found", path: join(configured, "skills") };
}

/** Makes `text` the skill's only file in `skillsFolder`, and returns that file's path. */
export async function installSkill(text: string, skillsFolder: string): Promise<string> {
  const folder = join(skillsFolder, SKILL_NAME);
  await rm(folder, { recursive: true, force: true });
  const path = join(folder, "SKILL.md");
  await Bun.write(path, text);
  return path;
}

export type InstallOptions = {
  env?: Record<string, string | undefined>;
  home?: string;
  print?: Print;
};

/** Runs `toy-box-slack install-skill`, says where the skill went, and returns the exit code. */
export async function installBundledSkill({
  env = process.env,
  home = homedir(),
  print = printToProcess,
}: InstallOptions = {}): Promise<ExitCode> {
  const folder = resolveSkillsFolder(env, home);
  if (folder.kind === "refused") return printOutcome(explain(1, folder.message), false, print);
  const path = await installSkill(await Bun.file(BUNDLED_SKILL).text(), folder.path);
  print("stdout", `${presentInstalled(path, Boolean(env.COPILOT_HOME))}\n`);
  return 0;
}

/** Where the skill went, and when a lead finds it. */
export function presentInstalled(path: string, copilotHome: boolean): string {
  const lines = [
    `Installed the toy-box-slack skill at ${path}.`,
    "Copilot reads skills when a lead's session starts or resumes, so a lead that's already running may not see it until later. Until then, its routines carry what each run needs.",
  ];
  if (copilotHome) {
    lines.push(
      "It went there because COPILOT_HOME is set, so leads find it only if Toy Box runs with the same COPILOT_HOME.",
    );
  }
  return lines.join("\n\n");
}

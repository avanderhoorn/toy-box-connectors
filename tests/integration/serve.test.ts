// What `toy-box-slack serve` sets up as it starts, before it says it's running.

import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { BUNDLED_SKILL } from "@commands/client/skill";
import { installedSkill, spawnBridge, started } from "./bridgeProcess";

test("installs the skill it ships each time it starts, in place of the one before", async () => {
  const home = createTestFolder();
  const skill = installedSkill(home);
  mkdirSync(join(dirname(skill), "references"), { recursive: true });
  writeFileSync(skill, "An older release's skill");
  writeFileSync(join(dirname(skill), "references", "stale.md"), "Stale");

  const bridge = spawnBridge(home);
  await bridge.running();

  expect(await Bun.file(skill).text()).toBe(await Bun.file(BUNDLED_SKILL).text());
  expect(readdirSync(dirname(skill))).toEqual(["SKILL.md"]);
  bridge.child.kill("SIGTERM");
  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `${started(home)}toy-box-slack is stopping after SIGTERM\n`,
  });
}, 15_000);

test("says why it couldn't install the skill, and runs anyway", async () => {
  const home = createTestFolder();
  writeFileSync(join(home, ".copilot"), "Not a folder");

  const bridge = spawnBridge(home);
  await bridge.running();
  bridge.child.kill("SIGTERM");

  const { code, stderr } = await bridge.exit();
  const [said, ...rest] = stderr.split("\n");
  expect(code).toBe(0);
  expect(said).toStartWith("Couldn't install the toy-box-slack skill: ENOTDIR: not a directory");
  expect(rest.join("\n")).toBe(
    `toy-box-slack is running for ${join(home, ".toy-box-slack")}\ntoy-box-slack is stopping after SIGTERM\n`,
  );
}, 15_000);

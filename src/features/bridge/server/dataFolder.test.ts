import { expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { createTestFolder } from "./testFixtures";

test("the data folder is ~/.toy-box-slack unless TOY_BOX_SLACK_HOME names another", () => {
  const resolve = (home?: string) => resolveDataFolder({ TOY_BOX_SLACK_HOME: home }, "/Users/ada");

  expect(resolve()).toBe("/Users/ada/.toy-box-slack");
  expect(resolve("")).toBe("/Users/ada/.toy-box-slack");
  expect(resolve("/Volumes/work/bridge")).toBe("/Volumes/work/bridge");
});

test("the data folder is created with its parents for its owner alone, and refused once others can open it", () => {
  const path = join(createTestFolder(), "home", ".toy-box-slack");
  prepareDataFolder(path);
  expect(statSync(path).mode & 0o777).toBe(0o700);
  prepareDataFolder(path);

  for (const mode of [0o750, 0o755, 0o777, 0o710, 0o701, 0o600]) {
    chmodSync(path, mode);
    expect(() => prepareDataFolder(path)).toThrow(
      `The data folder ${path} has mode ${mode.toString(8)}, but it must be 700 so only you can open it. Run \`chmod 700 ${path}\` and start the bridge again.`,
    );
  }
});

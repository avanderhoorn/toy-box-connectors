import { expect, test } from "bun:test";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataFolderProblem, prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder } from "./testFixtures";

function modeOf(path: string) {
  return statSync(path).mode & 0o777;
}

test("the data folder is ~/.toy-box-slack, or TOY_BOX_SLACK_HOME in normal form when it's absolute", () => {
  const resolve = (home?: string) => resolveDataFolder({ TOY_BOX_SLACK_HOME: home }, "/Users/ada");

  expect(resolve()).toBe("/Users/ada/.toy-box-slack");
  expect(resolve("")).toBe("/Users/ada/.toy-box-slack");
  expect(resolve("/Volumes/work//slack/../bridge/")).toBe("/Volumes/work/bridge");
  expect(() => resolve("~/bridge")).toThrow(
    `TOY_BOX_SLACK_HOME must be an absolute path, but it's "~/bridge".`,
  );
});

test("only a folder that its owner alone can open may hold the bridge's data", () => {
  const path = "/Users/ada/.toy-box-slack";
  const folder = (mode: number, uid = 501) => ({ isDirectory: () => true, mode, uid });

  expect(dataFolderProblem(path, folder(0o40700), 501)).toBeNull();
  expect(dataFolderProblem(path, { ...folder(0o100600), isDirectory: () => false }, 501)).toBe(
    `${path} isn't a folder, so it can't be the data folder. Set TOY_BOX_SLACK_HOME to a folder you own.`,
  );
  expect(dataFolderProblem(path, folder(0o40700, 0), 501)).toBe(
    `The data folder ${path} belongs to another user. Set TOY_BOX_SLACK_HOME to a folder you own.`,
  );
  for (const mode of [0o750, 0o755, 0o777, 0o710, 0o701, 0o600]) {
    expect(dataFolderProblem(path, folder(0o40000 | mode), 501)).toBe(
      `The data folder ${path} has mode ${mode.toString(8)}, but it must be 700 so only you can open it. Run \`chmod 700 ${path}\` and start the bridge again.`,
    );
  }
});

test("a missing data folder is created with its parents for its owner alone, whatever the umask", () => {
  const nested = join(createTestFolder(), "home", ".toy-box-slack");
  prepareDataFolder(nested);
  expect(modeOf(nested)).toBe(0o700);

  const path = join(createTestFolder(), ".toy-box-slack");
  const umask = process.umask(0o277);
  try {
    prepareDataFolder(path);
  } finally {
    process.umask(umask);
  }
  expect(modeOf(path)).toBe(0o700);
});

test("an existing data folder is used as it is, or refused and left alone", () => {
  const owned = createTestFolder();
  chmodSync(owned, 0o700);
  prepareDataFolder(owned);
  expect(modeOf(owned)).toBe(0o700);

  const shared = createTestFolder();
  chmodSync(shared, 0o755);
  expect(() => prepareDataFolder(shared)).toThrow(BridgeRefusedError);
  expect(modeOf(shared)).toBe(0o755);

  const file = join(createTestFolder(), ".toy-box-slack");
  writeFileSync(file, "");
  expect(() => prepareDataFolder(file)).toThrow(`${file} isn't a folder`);
});

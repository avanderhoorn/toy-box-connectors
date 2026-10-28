import { describe, expect, test } from "bun:test";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataFolderProblem, prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder } from "./testFixtures";

function modeOf(path: string) {
  return statSync(path).mode & 0o777;
}

describe("resolveDataFolder", () => {
  test("names .toy-box-slack in the home folder by default", () => {
    expect(resolveDataFolder({}, "/Users/ada")).toBe("/Users/ada/.toy-box-slack");
  });

  test("treats an empty TOY_BOX_SLACK_HOME as unset", () => {
    expect(resolveDataFolder({ TOY_BOX_SLACK_HOME: "" }, "/Users/ada")).toBe(
      "/Users/ada/.toy-box-slack",
    );
  });

  test("uses TOY_BOX_SLACK_HOME in normal form", () => {
    const env = { TOY_BOX_SLACK_HOME: "/Volumes/work//slack/../bridge/" };

    expect(resolveDataFolder(env, "/Users/ada")).toBe("/Volumes/work/bridge");
  });

  test("refuses a relative TOY_BOX_SLACK_HOME, which names a different folder for each process", () => {
    const resolve = () => resolveDataFolder({ TOY_BOX_SLACK_HOME: "~/bridge" }, "/Users/ada");

    expect(resolve).toThrow(BridgeRefusedError);
    expect(resolve).toThrow(`TOY_BOX_SLACK_HOME must be an absolute path, but it's "~/bridge".`);
  });
});

describe("dataFolderProblem", () => {
  const folder = (mode: number, uid = 501) => ({ isDirectory: () => true, mode, uid });

  test("accepts a folder that only its owner can open", () => {
    expect(dataFolderProblem("/Users/ada/.toy-box-slack", folder(0o40700), 501)).toBeNull();
  });

  test("refuses anything other than a folder", () => {
    const file = { isDirectory: () => false, mode: 0o100600, uid: 501 };

    expect(dataFolderProblem("/Users/ada/.toy-box-slack", file, 501)).toBe(
      "/Users/ada/.toy-box-slack isn't a folder, so it can't be the data folder. Set TOY_BOX_SLACK_HOME to a folder you own.",
    );
  });

  test("refuses a folder that belongs to another user", () => {
    expect(dataFolderProblem("/Users/ada/.toy-box-slack", folder(0o40700, 0), 501)).toBe(
      "The data folder /Users/ada/.toy-box-slack belongs to another user. Set TOY_BOX_SLACK_HOME to a folder you own.",
    );
  });

  test("refuses any mode but 700 and says how to fix it", () => {
    for (const mode of [0o750, 0o755, 0o777, 0o710, 0o701, 0o600]) {
      expect(dataFolderProblem("/Users/ada/.toy-box-slack", folder(0o40000 | mode), 501)).toBe(
        `The data folder /Users/ada/.toy-box-slack has mode ${mode.toString(8)}, but it must be 700 so only you can open it. Run \`chmod 700 /Users/ada/.toy-box-slack\` and start the bridge again.`,
      );
    }
  });
});

describe("prepareDataFolder", () => {
  test("creates a missing folder and its missing parents for its owner alone", () => {
    const path = join(createTestFolder(), "home", ".toy-box-slack");

    prepareDataFolder(path);

    expect(modeOf(path)).toBe(0o700);
  });

  test("creates the folder with mode 700 even when the umask would withhold some of it", () => {
    const path = join(createTestFolder(), ".toy-box-slack");
    const umask = process.umask(0o277);
    try {
      prepareDataFolder(path);
    } finally {
      process.umask(umask);
    }

    expect(modeOf(path)).toBe(0o700);
  });

  test("accepts an existing folder that only its owner can open", () => {
    const path = createTestFolder();
    chmodSync(path, 0o700);

    prepareDataFolder(path);

    expect(modeOf(path)).toBe(0o700);
  });

  test("refuses an existing folder that others can open and leaves its mode alone", () => {
    const path = createTestFolder();
    chmodSync(path, 0o755);

    expect(() => prepareDataFolder(path)).toThrow(BridgeRefusedError);
    expect(modeOf(path)).toBe(0o755);
  });

  test("refuses a file in the folder's place", () => {
    const path = join(createTestFolder(), ".toy-box-slack");
    writeFileSync(path, "");

    expect(() => prepareDataFolder(path)).toThrow(`${path} isn't a folder`);
  });
});

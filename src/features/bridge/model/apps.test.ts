import { describe, expect, test } from "bun:test";
import { addedAppNameProblem, appNameSchema, DEFAULT_APP } from "./apps";

const GOOD_NAMES = ["releases", "a", "0", "ops-2", "x-", "a--b", "a".repeat(32)];
const BAD_NAMES = [
  "",
  "-x",
  "Releases",
  "re leases",
  "re_leases",
  "re.leases",
  "relé",
  "a".repeat(33),
  "..",
  "../x",
  "x/y",
  ".hidden",
  "releases\n",
];

describe("an added app's name", () => {
  test("is 1 to 32 lowercase letters, digits and hyphens", () => {
    for (const name of GOOD_NAMES) expect(addedAppNameProblem(name)).toBeNull();
  });

  test("is refused otherwise, so it's always one folder in apps/ that reads the same on any disk", () => {
    for (const name of BAD_NAMES) {
      expect(addedAppNameProblem(name)).toBe(
        "An app's name is 1 to 32 lowercase letters, digits and hyphens, and doesn't start with a hyphen.",
      );
    }
  });

  test("can't be default, which names the data folder's own app", () => {
    expect(addedAppNameProblem(DEFAULT_APP)).toBe(
      "An added app can't be named default, since that's the data folder's own app.",
    );
  });
});

describe("the app a command names", () => {
  test("is default or a name add-app takes", () => {
    for (const name of [DEFAULT_APP, ...GOOD_NAMES]) expect(appNameSchema.parse(name)).toBe(name);
  });

  test("is refused otherwise, saying what to give", () => {
    for (const name of BAD_NAMES) {
      expect(appNameSchema.safeParse(name).error?.issues.map(({ message }) => message)).toEqual([
        "Give default or the name add-app gave the app, such as releases",
      ]);
    }
  });
});

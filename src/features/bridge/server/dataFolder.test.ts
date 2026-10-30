import { expect, test } from "bun:test";
import { resolveDataFolder } from "./dataFolder";

test("the data folder is ~/.toy-box-slack unless TOY_BOX_SLACK_HOME names another", () => {
  const resolve = (home?: string) => resolveDataFolder({ TOY_BOX_SLACK_HOME: home }, "/Users/ada");

  expect(resolve()).toBe("/Users/ada/.toy-box-slack");
  expect(resolve("")).toBe("/Users/ada/.toy-box-slack");
  expect(resolve("/Volumes/work/bridge")).toBe("/Volumes/work/bridge");
});

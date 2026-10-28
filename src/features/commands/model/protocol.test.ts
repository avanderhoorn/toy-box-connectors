import { expect, test } from "bun:test";
import { commandAt, commandPath } from "./protocol";

test("a command's path names it, and nothing else names a command", () => {
  expect(commandAt(commandPath("mark-read"))).toBe("mark-read");
  for (const path of [
    "/",
    "/v1/commands/",
    "/v1/commands/status/extra",
    "/v1/commands/Status",
    "/v1/commands/-status",
    "/v2/commands/status",
  ]) {
    expect(commandAt(path)).toBeNull();
  }
});

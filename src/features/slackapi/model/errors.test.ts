import { expect, test } from "bun:test";
import { isRequestFault } from "./errors";

test.each<[string, string[], boolean]>([
  ["an error after a warning", ["[WARN] superfluous_charset", "[ERROR] invalid_blocks"], true],
  ["only a warning", ["[WARN] A Content-Type HTTP header did not declare a charset"], false],
])("tells whether Slack explained a fault in the request from %s", (_, messages, fault) => {
  expect(isRequestFault(messages)).toBe(fault);
});

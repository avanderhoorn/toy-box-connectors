import { expect, test } from "bun:test";
import { compareTs, slackTsSchema, tsAt } from "./ts";

test("message identity uses exact decimal ordering, never floating point", () => {
  for (const [left, right] of [
    ["9007199254740991.000100", "9007199254740991.000101"],
    ["9.9", "10.1"],
    ["1.0001", "1.001"],
  ]) {
    expect(compareTs(left!, right!)).toBeLessThan(0);
    expect(compareTs(right!, left!)).toBeGreaterThan(0);
  }
  expect(compareTs("0001.1", "1.1000")).toBe(0);
  expect(tsAt(1001)).toBe("1.001000");
  expect(slackTsSchema.safeParse(1.001).success).toBe(false);
});

import { describe, expect, test } from "bun:test";
import { compareTs, epochSecondsSchema, laterTs, slackTsSchema, tsAt } from "./ts";

describe("Slack ts", () => {
  test("orders by seconds, then by fraction", () => {
    expect(compareTs("1700000000.000100", "1700000000.000100")).toBe(0);
    expect(compareTs("1700000000.000100", "1700000000.000101")).toBeLessThan(0);
    expect(compareTs("1700000001.000000", "1700000000.999999")).toBeGreaterThan(0);
  });

  test("compares seconds as numbers, not text", () => {
    expect(compareTs("999.999999", "1000.000000")).toBeLessThan(0);
    expect(compareTs("0001.5", "1.5")).toBe(0);
    expect(compareTs("0.000001", "0000.000002")).toBeLessThan(0);
  });

  test("compares fractions of different lengths by value", () => {
    expect(compareTs("1.5", "1.50")).toBe(0);
    expect(compareTs("1.5", "1.49")).toBeGreaterThan(0);
    expect(compareTs("1.05", "1.5")).toBeLessThan(0);
  });

  test("tells apart neighbors a float would merge", () => {
    const [earlier, later] = ["1700000000.1234567", "1700000000.1234568"];
    expect(Number(earlier)).toBe(Number(later));
    expect(compareTs(earlier, later)).toBeLessThan(0);
  });

  test("sorts consistently in both directions", () => {
    const ordered = ["0.000001", "1.05", "1.5", "999.999999", "1000.0", "1700000000.000100"];
    for (const [i, left] of ordered.entries()) {
      for (const [j, right] of ordered.entries()) {
        expect(Math.sign(compareTs(left, right))).toBe(Math.sign(i - j));
      }
    }
    expect(ordered.toReversed().sort(compareTs)).toEqual(ordered);
  });

  test("refuses anything that isn't a decimal ts", () => {
    for (const invalid of ["1700000000", "1700000000.", ".5", "1.5e3", " 1.5", "-1.5", "1.5\n"]) {
      expect(() => compareTs(invalid, "1.5")).toThrow(TypeError);
      expect(() => compareTs("1.5", invalid)).toThrow(TypeError);
      expect(slackTsSchema.safeParse(invalid).success).toBe(false);
    }
    expect(slackTsSchema.safeParse(1700000000.0001).success).toBe(false);
    expect(slackTsSchema.parse("1700000000.000100")).toBe("1700000000.000100");
  });

  test("picks the later ts by value", () => {
    expect(laterTs("999.0", "1000.0")).toBe("1000.0");
    expect(laterTs("1000.0", "999.0")).toBe("1000.0");
    expect(laterTs("1.5", "1.50")).toBe("1.5");
  });

  test("names a moment as a six-digit ts", () => {
    expect(tsAt(1_700_000_000_123)).toBe("1700000000.123000");
    expect(tsAt(5)).toBe("0.005000");
    expect(compareTs(tsAt(1_700_000_000_000), "1700000000.000000")).toBe(0);
    expect(() => tsAt(-1)).toThrow(RangeError);
    expect(() => tsAt(1.5)).toThrow(RangeError);
  });
});

test("a time in epoch seconds is a whole second from 1970 to the last a Date can hold", () => {
  for (const seconds of [0, 1_700_000_000, 8_640_000_000_000]) {
    expect(epochSecondsSchema.parse(seconds)).toBe(seconds);
  }
  for (const seconds of [-1, 1_700_000_000.5, 8_640_000_000_001, Number.NaN, Infinity]) {
    expect(epochSecondsSchema.safeParse(seconds).success).toBe(false);
  }
  expect(tsAt(8_640_000_000_000 * 1_000)).toBe("8640000000000.000000");
});

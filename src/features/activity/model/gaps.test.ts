import { describe, expect, test } from "bun:test";
import { gapOverlapMs, interruptionGap, rateLimitedGap, threadGap } from "./gaps";

const linkedAtTs = "1700000000.000100";
const minute = 1700003600;

describe("gap windows", () => {
  test("a rate-limited minute is padded on both sides by the overlap", () => {
    expect(rateLimitedGap(minute, linkedAtTs)).toEqual({
      oldestTs: "1700003300.000000",
      latestTs: "1700003960.000000",
    });
    expect(gapOverlapMs).toBe(300_000);
  });

  test("an interruption runs from the last moment the bridge was receiving, with overlap", () => {
    expect(interruptionGap(1_700_003_600_250, 1_700_007_200_000, linkedAtTs)).toEqual({
      oldestTs: "1700003300.250000",
      latestTs: "1700007500.000000",
    });
  });

  test("a gap never reaches back before its link", () => {
    expect(interruptionGap(1_700_000_010_000, 1_700_000_100_000, linkedAtTs)).toEqual({
      oldestTs: linkedAtTs,
      latestTs: "1700000400.000000",
    });
    expect(rateLimitedGap(1700000040, linkedAtTs)?.oldestTs).toBe(linkedAtTs);
  });

  test("a link that began after the span has no gap", () => {
    expect(rateLimitedGap(1699990000, linkedAtTs)).toBeNull();
    expect(interruptionGap(1_699_990_000_000, 1_699_999_000_000, linkedAtTs)).toBeNull();
  });

  test("a span that ends exactly when its link began is empty", () => {
    const linkedAt = "1700000000.000000";
    expect(interruptionGap(1_699_990_000_000, 1_699_999_700_000, linkedAt)).toBeNull();
    expect(interruptionGap(1_699_990_000_000, 1_699_999_700_001, linkedAt)).toEqual({
      oldestTs: linkedAt,
      latestTs: "1700000000.001000",
    });
  });

  test("a span near the epoch stops at zero instead of failing", () => {
    expect(interruptionGap(1_000, 2_000, "0.000000")).toEqual({
      oldestTs: "0.000000",
      latestTs: "302.000000",
    });
  });

  test("a thread is read from its root to past now", () => {
    expect(threadGap("1700000000.000100", 1_700_000_500_000)).toEqual({
      oldestTs: "1700000000.000100",
      latestTs: "1700000800.000000",
    });
  });
});

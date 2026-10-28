import { expect, test } from "bun:test";
import { ago, count, duration } from "./wording";

const MINUTE = 60_000;

test("counts one without a plural", () => {
  expect(count(1, "message")).toBe("1 message");
  expect(count(0, "message")).toBe("0 messages");
  expect(count(3, "message")).toBe("3 messages");
});

test.each([
  [-MINUTE, "less than a minute"],
  [59_999, "less than a minute"],
  [MINUTE, "1 minute"],
  [59 * MINUTE + 59_999, "59 minutes"],
  [60 * MINUTE, "1 hour"],
  [47 * 60 * MINUTE + 59 * MINUTE, "47 hours"],
  [48 * 60 * MINUTE, "2 days"],
  [7 * 24 * 60 * MINUTE - 1, "6 days"],
])("a span of %pms is %p", (milliseconds, words) => {
  expect(duration(milliseconds)).toBe(words);
});

test("an age under a minute is just now, and later ones say how long ago", () => {
  expect(ago(-MINUTE)).toBe("just now");
  expect(ago(59_999)).toBe("just now");
  expect(ago(MINUTE)).toBe("1 minute ago");
  expect(ago(50 * 60 * MINUTE)).toBe("2 days ago");
});

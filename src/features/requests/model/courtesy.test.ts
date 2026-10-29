import { expect, test } from "bun:test";
import { isCourtesyOnly } from "./courtesy";

test.each([
  "Thank you.",
  "ok, thanks!",
  "thanks\n🙏",
  ":tada:",
  "👍🏽",
  "❤️",
  "👨‍💻 thanks",
  "\u{1FC00}",
  "<@U-bot|toy-box> thank you",
  "thanks &amp; cheers",
  "",
])("%p only thanks or acknowledges", (text) => {
  expect(isCourtesyOnly({ text })).toBe(true);
});

test.each([
  "yes",
  "lgtm",
  "thanks, can you also check staging?",
  "thanksgiving plans?",
  "is it ok?",
  "ok?",
  "?",
  "<@U-bot|toy-box> ？",
])("%p could carry a decision or a question", (text) => {
  expect(isCourtesyOnly({ text })).toBe(false);
});

test("unclosed markup can't stall the check", () => {
  const started = performance.now();
  expect(isCourtesyOnly({ text: "<@U1 ".repeat(80_000) })).toBe(false);
  expect(performance.now() - started).toBeLessThan(500);
});

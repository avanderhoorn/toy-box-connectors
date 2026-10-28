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
])("%p could carry a decision or a question", (text) => {
  expect(isCourtesyOnly({ text })).toBe(false);
});

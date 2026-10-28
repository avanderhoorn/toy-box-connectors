import { expect, test } from "bun:test";
import { isCourtesyOnly } from "./courtesy";

test.each([
  "thanks!",
  "Thank you.",
  "THX",
  "Okay...",
  "ok, thanks!",
  "Great, thank you so much!",
  "got it -- thx",
  ":tada:",
  "🙏",
  "👍🏽",
  "❤️",
  "🇺🇸",
  "👨‍💻 thanks",
  "\u{1FC00}",
  "thanks :+1::skin-tone-2:",
  "<@UBOT|toy-box> thank you",
  "<!here> ok",
  "thanks &amp; cheers",
  "",
])("%p only thanks or acknowledges", (text) => {
  expect(isCourtesyOnly({ text })).toBe(true);
});

test.each([
  "yes",
  "no",
  "lgtm",
  "ok go ahead",
  "thanks, can you also check staging?",
  "thanksgiving plans?",
  "nicety",
  "great question",
  "cool, what about prod?",
  "1",
])("%p could carry a decision or a question", (text) => {
  expect(isCourtesyOnly({ text })).toBe(false);
});

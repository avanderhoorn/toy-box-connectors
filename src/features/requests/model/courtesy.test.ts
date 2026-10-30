import { expect, test } from "bun:test";
import { asksQuestion, isCourtesyOnly } from "./courtesy";

const courtesy = (text: string) =>
  isCourtesyOnly({ text, mentionsBot: text.includes("<@U-bot"), files: [] });

test.each([
  "Thank you.",
  "thanks\n🙏",
  "👍🏽",
  "❤️",
  "👨‍💻 thanks",
  "\u{1FC00}",
  "<@U-bot|toy-box> thank you",
  "<@U-bot> 👍",
  "thanks &amp; cheers",
  "",
])("%p only thanks or acknowledges", (text) => {
  expect(courtesy(text)).toBe(true);
});

test.each(["yes", "lgtm", "thanksgiving", "is it ok", "ok？"])(
  "%p could carry a decision or a question",
  (text) => {
    expect(courtesy(text)).toBe(false);
  },
);

test('"<@U-bot|toy-box>!" asks the lead to read the thread', () => {
  expect(courtesy("<@U-bot|toy-box>!")).toBe(false);
});

test("unclosed markup can't stall the check", () => {
  const started = performance.now();
  expect(courtesy("<@U1 ".repeat(80_000))).toBe(false);
  expect(performance.now() - started).toBeLessThan(500);
});

test.each(["Did you check https://status.example.com?", "Is `main` the right branch？"])(
  "%p asks something",
  (text) => {
    expect(asksQuestion(text)).toBe(true);
  },
);

test.each([
  "Deployed. See https://github.com/o/r/pulls?q=is%3Aopen for the rest.",
  "Read [Why is CI red?](https://wiki.example.com/ci) first.",
  "Read <https://wiki.example.com/ci|Why is CI red?> first.",
  "I guarded it with `user?.name`.",
  "```\nconst name = user ? user.name : null;\n```",
])("%p asks nothing, whatever its links and code hold", (text) => {
  expect(asksQuestion(text)).toBe(false);
});

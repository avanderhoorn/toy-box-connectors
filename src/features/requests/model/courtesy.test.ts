import { describe, expect, test } from "bun:test";
import { isCourtesyOnly } from "./courtesy";

const courteous = (text: string) => isCourtesyOnly({ text, files: [] });

describe("courtesy", () => {
  test("thanks and acknowledgements in any case or punctuation are courtesy", () => {
    for (const text of [
      "thanks!",
      "Thank you.",
      "THX",
      "ty",
      "ok",
      "Okay...",
      "got it",
      "Cheers!",
    ]) {
      expect(`${text}:${courteous(text)}`).toBe(`${text}:true`);
    }
  });

  test("several courtesy phrases together are still courtesy", () => {
    for (const text of ["ok, thanks!", "Great, thank you so much!", "cool cool", "got it -- thx"]) {
      expect(`${text}:${courteous(text)}`).toBe(`${text}:true`);
    }
  });

  test("emoji, shortcodes and mentions around courtesy don't count", () => {
    for (const text of [
      ":tada:",
      "🙏",
      "👍🏽",
      "❤️",
      "🇺🇸",
      "👨‍💻 thanks",
      "\u{1FC00}",
      "thanks ^_^",
      "thanks :+1::skin-tone-2:",
      "<@UBOT> thanks",
      "<@UBOT|toy-box> thank you",
      "<!here> ok",
      "thanks &amp; cheers",
      "",
    ]) {
      expect(`${text}:${courteous(text)}`).toBe(`${text}:true`);
    }
  });

  test("anything that could carry a decision or a question isn't courtesy", () => {
    for (const text of [
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
    ]) {
      expect(`${text}:${courteous(text)}`).toBe(`${text}:false`);
    }
  });

  test("a message with a file is never courtesy", () => {
    expect(
      isCourtesyOnly({
        text: "thanks",
        files: [{ id: "F1", name: null, mimetype: null, size: null }],
      }),
    ).toBe(false);
  });
});

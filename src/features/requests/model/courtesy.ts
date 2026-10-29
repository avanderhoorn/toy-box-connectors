import type { SlackMessage } from "@slackapi/model/messages";

// Courtesy messages.
//
// A thank-you or an okay shouldn't open a request or send the lead back to a
// thread it already answered. Only short, closed phrases count, so a message
// that could carry a decision, such as yes, no or lgtm, still reaches the lead.

const courtesyPhrases = [
  "thanks",
  "thank you",
  "thx",
  "ty",
  "tysm",
  "thanks a lot",
  "thanks so much",
  "thank you so much",
  "many thanks",
  "much appreciated",
  "appreciate it",
  "ok",
  "okay",
  "cool",
  "great",
  "nice",
  "perfect",
  "awesome",
  "got it",
  "sounds good",
  "no worries",
  "cheers",
];

const courtesyPhrase = `(?:${courtesyPhrases.join("|")})`;
const courtesyPattern = new RegExp(`^${courtesyPhrase}(?: ${courtesyPhrase})*$`);

/** Whether a message only thanks or acknowledges, such as "thanks!", "ok 👍" or a lone emoji. */
export function isCourtesyOnly(message: Pick<SlackMessage, "text">): boolean {
  // A question waits for an answer, even a lone ? or an ok?.
  if (/[?？]/.test(message.text)) return false;
  const words = message.text
    .replace(/<[@!][^<>]*>/g, " ")
    .replace(/&(?:amp|lt|gt);/g, " ")
    .replace(/:[\w+'-]+:/g, " ")
    // Symbols include most emoji, skin tones and flags. Pictographs also cover
    // emoji newer than this runtime's Unicode tables.
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}]|\u200d|\ufe0f/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(" ");
  return words === "" || courtesyPattern.test(words);
}

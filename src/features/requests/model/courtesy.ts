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
export function isCourtesyOnly(
  message: Pick<SlackMessage, "text" | "mentionsBot" | "files">,
): boolean {
  // A question waits for an answer, even a lone ? or an ok?, and a shared file waits to be read.
  if (/[?？]/.test(message.text) || message.files.length > 0) return false;
  const unmarked = message.text.replace(/<[@!][^<>]*>/g, " ");
  // A bare mention, even with a ! after it, asks the lead to read the thread.
  if (message.mentionsBot && !/[^\s\p{P}]/u.test(unmarked)) return false;
  const words = unmarked
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

/**
 * Whether a message of ours asks something, so a reply to it may be an answer rather than courtesy.
 * Our answers often hold a ? in code, a link or a URL, and those ask nothing.
 */
export function asksQuestion(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[[^[\]\n]*\]\([^()\s]*\)/g, " ")
    .replace(/<[^<>]*>/g, " ")
    // A URL ends before trailing punctuation, as in "Did you check https://example.com?".
    .replace(/\bhttps?:\/\/[^\s<>]*[^\s<>?!.,:;*_~'")\]]/gi, " ");
  return /[?？]/.test(prose);
}

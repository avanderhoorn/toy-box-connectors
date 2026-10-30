import { expect, test } from "bun:test";
import { fileTextPage, presentFileAnswer, presentListedFile, type FileAnswer } from "./file";

const ALICE = { userId: "U-alice", name: "Alice Chen" };
const about = { file: "f12", name: "deploy.log", sharer: ALICE, uploader: ALICE };

/** Page `page` of Alice's file of `text`, which `uploader` uploaded. */
function textAnswer(text: string, page: number, uploader = ALICE): FileAnswer {
  const shown = fileTextPage(text, page);
  if (shown === null) throw new Error(`The text has no page ${page}.`);
  return { ...about, uploader, format: "text", ...shown };
}

test.each<[string, FileAnswer, string]>([
  [
    "one page is fenced under who shared it, beyond any backticks in it, mentioning no one",
    textAnswer("Ask @lead about ```this```\n", 1),
    '````file f12 from Alice Chen: "deploy.log"\nAsk @\u200blead about ```this```\n````',
  ],
  [
    "the first of two pages names who uploaded it when someone else did, and how to read on",
    textAnswer(`${"a".repeat(30_000)} `, 1, { userId: "U-bob", name: "Bob" }),
    `\`\`\`file f12 from Alice Chen, uploaded by Bob: "deploy.log"\n${"a".repeat(30_000)}\n\`\`\`\nPage 1 of 2. Run \`toy-box-slack file f12 --page 2\` for the next.`,
  ],
  [
    "the last page says so, even when it's only spaces",
    textAnswer(`${"a".repeat(30_000)} `, 2),
    '```file f12 from Alice Chen: "deploy.log"\n \n```\nPage 2 of 2, the last.',
  ],
  [
    "a blank file says so, instead of fencing nothing",
    textAnswer(" \n", 1),
    'f12 is a blank text file from Alice Chen: "deploy.log"',
  ],
  [
    "a file without a name goes unnamed",
    { ...textAnswer("Deploy failed at step 3.\n", 1), name: null },
    "```file f12 from Alice Chen\nDeploy failed at step 3.\n```",
  ],
])("%s", (_, answer, text) => {
  expect(presentFileAnswer(answer)).toBe(text);
});

test.each<[number, string]>([
  [1_023, "1023 bytes"],
  [1_024, "1 KB"],
  [1_048_575, "1.0 MB"],
])("a file of %d bytes lists as %s, in units of 1,024", (size, shown) => {
  expect(presentListedFile({ reference: "f12", format: "text", size, name: null })).toBe(
    `- f12, text, ${shown}, read it with \`toy-box-slack file f12\``,
  );
});

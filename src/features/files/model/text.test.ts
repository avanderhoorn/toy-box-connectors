import { expect, test } from "bun:test";
import { pageLength, readText, textPage, type FileText } from "./text";

const notText: FileText = { kind: "refused", reason: "it isn't UTF-8 text" };

test.each<[string, Uint8Array, FileText]>([
  ["tabs and line breaks stay, with CRLF as LF", utf8("a\tb\r\nc\n"), text("a\tb\nc\n")],
  [
    "every other control shows as U+FFFD, DEL and C1 too",
    utf8("\x1b[31mred\x1b[0m\r\x7f\x85"),
    text("\uFFFD[31mred\uFFFD[0m\uFFFD\uFFFD\uFFFD"),
  ],
  ["bytes that aren't UTF-8 aren't text", Uint8Array.of(0x63, 0x61, 0x66, 0xe9), notText],
  ["and nor is anything with a NUL", utf8("a\0b"), notText],
])("%s", (_, bytes, read) => {
  expect(readText(bytes)).toEqual(read);
});

test("a page holds 30,000 code points, however few characters they draw", () => {
  const marked = `a${"\u0301".repeat(999)}`.repeat(40);
  const [first, second] = [1, 2].map((page) => textPage(marked, page)!);
  expect([first!.pages, Array.from(first!.text).length, Array.from(second!.text).length]).toEqual([
    2,
    pageLength,
    10_000,
  ]);
});

test("pages split between code points, join back into the text, and stop at the last", () => {
  const split = `${"a".repeat(pageLength - 1)}😀b`;
  const [first, second, third] = [1, 2, 3].map((page) => textPage(split, page));
  expect(first!.text.endsWith("😀")).toBe(true);
  expect(first!.text + second!.text).toBe(split);
  expect(third).toBeNull();
});

test("an empty file has one page, which is page 1", () => {
  expect([textPage("", 0), textPage("", 1)]).toEqual([null, { text: "", page: 1, pages: 1 }]);
});

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: string): FileText {
  return { kind: "text", text: value };
}

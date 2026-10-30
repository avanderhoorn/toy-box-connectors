import { expect, test } from "bun:test";
import type { SlackFile } from "@slackapi/model/files";
import { judgeFile, type FileFormat, type FileVerdict, type SettledVerdict } from "./readable";

const mib = 1024 ** 2;
const notes: SlackFile = {
  id: "F1",
  whole: true,
  name: "notes.txt",
  mimeType: "text/plain",
  mode: "hosted",
  size: 2_048,
  uploaderId: "U-alice",
};
const allowed = (userId: string) => userId === "U-alice";

test.each<[string, SlackFile, FileVerdict]>([
  [
    "a snippet of up to 1 MiB reads as text",
    { ...notes, mode: "snippet", size: mib },
    readable("text"),
  ],
  [
    "but not text a byte longer",
    { ...notes, size: mib + 1 },
    refused("it's over 1 MB, more text than the bridge reads"),
  ],
  [
    "nor HTML, however its type is written",
    { ...notes, mimeType: "Text/HTML; charset=UTF-8" },
    refused("the bridge doesn't read HTML"),
  ],
  [
    "a JPEG of up to 10 MiB reads",
    { ...notes, mimeType: "image/jpeg", size: 10 * mib },
    readable("jpeg"),
  ],
  [
    "but not an image a byte bigger",
    { ...notes, mimeType: "image/png", size: 10 * mib + 1 },
    refused("it's over 10 MB, more than you can view, so ask for a crop or a JPEG"),
  ],
  [
    "nor a PDF",
    { ...notes, mimeType: "application/pdf" },
    refused("the bridge reads only text, PNG and JPEG"),
  ],
  [
    "nor a file whose type isn't a MIME type",
    { ...notes, mimeType: "text" },
    refused("the bridge reads only text, PNG and JPEG"),
  ],
  [
    "nor a post, Slack's own kind of document",
    { ...notes, mode: "post" },
    refused("the bridge reads only text, PNG and JPEG"),
  ],
  [
    "nor a file stored outside Slack",
    { ...notes, mode: "external" },
    refused("it's stored outside Slack"),
  ],
])("%s", (_, file, verdict) => {
  expect(judgeFile(file, "U-alice", allowed)).toEqual(verdict);
});

test("JSON, XML and YAML read as text", () => {
  for (const mimeType of [
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
  ]) {
    expect(judgeFile({ ...notes, mimeType }, "U-alice", allowed)).toEqual(readable("text"));
  }
});

test("no file reads from a message that names no one, even one someone allowed uploaded", () => {
  expect(judgeFile(notes, null, allowed)).toEqual(
    refused("whoever shared it isn't on the allowlist"),
  );
});

function readable(format: FileFormat): SettledVerdict {
  return { kind: "readable", format };
}

function refused(reason: string): SettledVerdict {
  return { kind: "refused", reason };
}

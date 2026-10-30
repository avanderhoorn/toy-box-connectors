// What people share in Slack reaches the lead only as it reads it: a text file a page at a time, and
// a screenshot as an image only the owner can open, which the bridge deletes. Nothing of either
// stays in the data folder, and the log never says where Slack keeps them.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { filesHolding } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, said, timestamps } from "./connectedBridge";

/** A text file of two pages, each with a key nobody says anywhere else. */
const NOTES = [
  "Deploy 4127 failed: the canary key PELICAN-48 expired.",
  ...Array.from({ length: 1_000 }, (_, index) => `Retry ${index + 1} of the release step failed.`),
  "The rollback finished with the fallback key HERON-17.",
].join("\n");
const SCREENSHOT = readFileSync(join(import.meta.dir, "..", "fixtures", "build-error.png"));
/** Compressed pixels from inside the screenshot's first IDAT chunk. */
const PIXELS = SCREENSHOT.subarray(3_000, 3_064);

const [askedTs, shownTs] = timestamps(2);

test("while the link is paused, the lead reads the text file Alice shares a page at a time and views her screenshot, and neither stays behind", async () => {
  const { slack, dataFolder, post, activity, file, stop, saying } = await connectedBridge({
    link: { status: "paused" },
  });
  const notes = slack.addFile(NOTES, { user: ALICE, name: "deploy-notes.txt" });
  const screenshot = slack.addFile(SCREENSHOT, {
    user: ALICE,
    name: "build-error.png",
    mimetype: "image/png",
  });
  const asked = `<@${BOT}> why did the deploy fail?`;
  await post(said(ALICE, askedTs, asked, { subtype: "file_share", files: [notes] }));
  await post(
    said(ALICE, shownTs, "Here's what it said.", {
      subtype: "file_share",
      thread_ts: askedTs,
      files: [screenshot],
    }),
  );

  const { threads } = await activity();
  expect(threads.flatMap(({ messages }) => messages.flatMap(({ files }) => files))).toEqual([
    { reference: "f1", format: "text", size: NOTES.length, name: "deploy-notes.txt" },
    { reference: "f2", format: "png", size: SCREENSHOT.length, name: "build-error.png" },
  ]);
  const pages = [await file("f1"), await file("f1", "2")];
  expect(pages.map(({ json }) => json)).toMatchObject([
    { page: 1, pages: 2, text: NOTES.slice(0, 30_000) },
    { page: 2, pages: 2, text: NOTES.slice(30_000) },
  ]);
  const { json: image } = await file("f2");
  expect(image).toMatchObject({ format: "png", width: 460, height: 86 });
  const { path } = image as { path: string };
  expect([modeOf(dirname(path)), modeOf(path), readFileSync(path).equals(SCREENSHOT)]).toEqual([
    0o700,
    0o600,
    true,
  ]);

  expect(await stop()).toEqual({ code: 0, stderr: saying() });
  expect(readdirSync(dirname(path))).toEqual([]);
  // Finding what Alice wrote shows the search sees what the bridge keeps.
  const holding = (part: string | Uint8Array) => filesHolding(dataFolder, part);
  expect([asked, "PELICAN-48", "HERON-17", PIXELS].map(holding)).toEqual([
    [join(dataFolder, "bridge.db")],
    [],
    [],
    [],
  ]);
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

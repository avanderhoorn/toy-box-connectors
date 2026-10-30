import { expect, jest, onTestFinished, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { captureLog, createTestFolder } from "@bridge/server/testFixtures";
import { openViewingFolder } from "./viewing";

const uuid = String.raw`[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}`;
const unexpected = (error: unknown) => {
  throw error;
};

test("an image is the owner's alone, under a name the bridge makes up, for ten minutes", async () => {
  jest.useFakeTimers();
  onTestFinished(() => jest.useRealTimers());
  const folder = join(createTestFolder(), "viewing");
  const viewing = openViewingFolder(folder, unexpected);

  const png = await viewing.show(12, "png", Uint8Array.of(0x89, 0x50));
  const jpeg = await viewing.show(13, "jpeg", Uint8Array.of(0xff, 0xd8));

  expect([basename(png), basename(jpeg)]).toEqual([
    expect.stringMatching(new RegExp(`^f12-${uuid}\\.png$`)),
    expect.stringMatching(new RegExp(`^f13-${uuid}\\.jpg$`)),
  ]);
  expect([modeOf(folder), modeOf(png), [...readFileSync(jpeg)]]).toEqual([
    0o700,
    0o600,
    [0xff, 0xd8],
  ]);
  jest.advanceTimersByTime(9 * 60_000);
  expect(readdirSync(folder)).toHaveLength(2);
  jest.advanceTimersByTime(2 * 60_000);
  expect(readdirSync(folder)).toEqual([]);
  viewing.close();
});

test("deletes only the images it makes, any a crash left when it opens and all of them when it closes", async () => {
  const folder = createTestFolder();
  const id = crypto.randomUUID();
  const others = [
    "notes.txt",
    "f3-build-error.png",
    `f-${id}.png`,
    `f3-${id}.gif`,
    `f3-${id}.png.part`,
    `old f3-${id}.png`,
  ];
  for (const name of [...others, `f3-${id}.png`]) writeFileSync(join(folder, name), "");
  mkdirSync(join(folder, `f4-${id}.jpg`));

  const viewing = openViewingFolder(folder, unexpected);
  const opened = readdirSync(folder).toSorted();
  await viewing.show(5, "png", Uint8Array.of(0x89));
  viewing.close();

  const kept = [...others, `f4-${id}.jpg`].toSorted();
  expect([opened, readdirSync(folder).toSorted()]).toEqual([kept, kept]);
});

test("a sweep that fails stops the bridge, saying why", () => {
  jest.useFakeTimers();
  onTestFinished(() => jest.useRealTimers());
  const folder = join(createTestFolder(), "viewing");
  const stopped: unknown[] = [];
  openViewingFolder(folder, (error) => stopped.push(error));
  writeFileSync(folder, "");
  const logged = captureLog();

  jest.advanceTimersByTime(60_000);

  expect(stopped).toEqual([expect.objectContaining({ code: "ENOTDIR" })]);
  expect(logged()).toEqual([
    expect.stringMatching(/^Couldn't delete the images the lead viewed: /),
  ]);
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

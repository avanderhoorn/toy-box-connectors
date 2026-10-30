import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { rebuildPng, type Rebuild } from "./png";
import { chunk, header, idat, iend, ihdr, png } from "./testFixtures";

const [gray, truecolor, palette] = [0, 2, 3];
const damaged: Rebuild = { kind: "refused", reason: "is damaged" };

test("a PNG keeps only its header, its transparent color and the rows from every IDAT", async () => {
  const header = ihdr(3, 2, 8, truecolor);
  const transparent = chunk("tRNS", [0, 255, 0, 0, 0, 0]);
  const rows = [0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 4, 10, 20, 30, 1, 1, 1, 2, 2, 2];
  const stream = deflateSync(Uint8Array.from(rows));
  const given = png(
    header,
    chunk("tEXt", text("Author\0the lead")),
    chunk("PLTE", [255, 0, 0]),
    transparent,
    chunk("eXIf", text("MM\0*GPS")),
    chunk("IDAT", stream.subarray(0, 8)),
    chunk("IDAT", [...stream.subarray(8), 0xde, 0xad]),
    iend,
    Uint8Array.from(text("PK\x03\x04a zip after the image")),
  );
  expect(await rebuildPng(given)).toEqual({
    kind: "png",
    png: { width: 3, height: 2, bytes: png(header, transparent, chunk("IDAT", stream), iend) },
  });
});

test("a palette PNG keeps its palette and its colors' alphas", async () => {
  const header = ihdr(3, 2, 2, palette);
  const colors = chunk("PLTE", [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const alphas = chunk("tRNS", [0, 128]);
  const pixels = idat([0, 0b00_01_10_00, 0, 0b11_10_01_00]);
  const given = png(
    header,
    colors,
    alphas,
    chunk("tIME", [7, 234, 10, 30, 18, 0, 0]),
    pixels,
    iend,
  );
  expect(await rebuildPng(given)).toEqual({
    kind: "png",
    png: { width: 3, height: 2, bytes: png(header, colors, alphas, pixels, iend) },
  });
});

test.each<[string, Uint8Array, Rebuild]>([
  [
    "a JPEG isn't a PNG",
    Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    { kind: "refused", reason: "isn't a PNG" },
  ],
  [
    "a PNG that doesn't open with its header is damaged",
    png(chunk("IDAT", header(1, 1, 8, gray)), idat([0, 0]), iend),
    damaged,
  ],
  [
    "and so is one whose header is cut short",
    png(chunk("IHDR", header(1, 1, 8, gray).slice(0, 12)), idat([0, 0]), iend),
    damaged,
  ],
  ["or that has no width", png(ihdr(0, 2, 8, gray), idat([0, 0]), iend), damaged],
  [
    "or a depth its color type can't have",
    png(ihdr(2, 1, 4, truecolor), idat([0, 0, 0, 0]), iend),
    damaged,
  ],
  [
    "or is a palette image without a palette",
    png(ihdr(1, 1, 8, palette), idat([0, 0]), iend),
    damaged,
  ],
  [
    "or with a color cut short",
    png(ihdr(1, 1, 8, palette), chunk("PLTE", [0, 0, 0, 9]), idat([0, 0]), iend),
    damaged,
  ],
  [
    "or with more colors than its pixels can index",
    png(ihdr(1, 1, 1, palette), chunk("PLTE", [0, 0, 0, 1, 1, 1, 2, 2, 2]), idat([0, 0]), iend),
    damaged,
  ],
  ["or that ends before its rows", png(ihdr(1, 1, 8, gray), iend, idat([0, 0])), damaged],
  ["or whose rows end early", png(ihdr(2, 2, 8, gray), idat([0, 1, 2]), iend), damaged],
  ["or run past its height", png(ihdr(1, 1, 8, gray), idat([0, 7, 0, 7]), iend), damaged],
  [
    "or has a row with a filter decoders don't know",
    png(ihdr(1, 2, 8, gray), idat([0, 1, 5, 2]), iend),
    damaged,
  ],
  [
    "an interlaced PNG is refused",
    png(ihdr(1, 1, 8, gray, 1), idat([0, 0]), iend),
    { kind: "refused", reason: "is interlaced, so save it without interlacing" },
  ],
  [
    "and so is one of over 20 megapixels, before its rows are decompressed",
    png(ihdr(5000, 4001, 1, gray), iend),
    { kind: "refused", reason: "is over 20 megapixels, so make it smaller" },
  ],
])("%s", async (_, bytes, rebuild) => {
  expect(await rebuildPng(bytes)).toEqual(rebuild);
});

function text(value: string): number[] {
  return [...Buffer.from(value)];
}

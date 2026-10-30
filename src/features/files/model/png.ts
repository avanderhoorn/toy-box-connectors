// The PNGs the lead posts, rebuilt from their pixels alone.
//
// A PNG can carry text, EXIF and a color profile beside its pixels, and bytes after its end that a
// viewer never shows, so the bridge never posts the file the lead gave it. It writes a new PNG of
// the header, the pixel rows, and the palette and transparency that give their colors, compressing
// the rows again as one chunk. The rows aren't decoded, only checked: they must fill exactly the
// size the header gives, each opening with a filter decoders know, and a palette image needs a
// palette of whole colors, no more than its pixels can index. The header's size is checked before
// anything decompresses, so a small file can't make the bridge decompress gigabytes, and zlib works
// off the main thread, so Slack's events don't wait.
// https://www.w3.org/TR/png-3/#5DataRep

import { promisify } from "node:util";
import { crc32, deflate, inflate } from "node:zlib";

/** A PNG the bridge wrote from an image's pixels, with its size in pixels. */
export type Png = { width: number; height: number; bytes: Uint8Array };
/** A PNG to post, or why the bridge won't post the image. A reason follows "image 2". */
export type Rebuild = { kind: "png"; png: Png } | { kind: "refused"; reason: string };

const maxPixels = 20_000_000;

const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const palette = 3;
// Each color type's channels per pixel, and the bits a channel may have.
const colorTypes: Partial<Record<number, { channels: number; depths: readonly number[] }>> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  [palette]: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const damaged: Rebuild = { kind: "refused", reason: "is damaged" };

/** The PNG to post in place of `bytes`, holding only their pixels. */
export async function rebuildPng(bytes: Uint8Array): Promise<Rebuild> {
  if (!signature.every((byte, index) => bytes[index] === byte)) return refused("isn't a PNG");
  const [header, ...chunks] = readChunks(bytes);
  if (header?.type !== "IHDR" || header.data.length !== 13) return damaged;
  const view = viewOf(header.data);
  const [width, height] = [view.getUint32(0), view.getUint32(4)];
  const [depth, colorType, interlace] = [view.getUint8(8), view.getUint8(9), view.getUint8(12)];
  const color = colorTypes[colorType];
  if (width * height === 0 || !color?.depths.includes(depth)) return damaged;
  if (interlace !== 0) return refused("is interlaced, so save it without interlacing");
  if (width * height > maxPixels) return refused("is over 20 megapixels, so make it smaller");
  const colors = chunks.find(({ type }) => type === "PLTE")?.data;
  if (colorType === palette && !paletteFits(colors, depth)) return damaged;

  const rowLength = 1 + Math.ceil((width * color.channels * depth) / 8);
  const pixels = chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data);
  const rows = await inflateExactly(join(pixels), rowLength * height);
  if (!rows || !filtersKnown(rows, rowLength)) return damaged;
  const transparency = chunks.find(({ type }) => type === "tRNS");
  const png = join([
    signature,
    chunk("IHDR", header.data),
    ...(colors && colorType === palette ? [chunk("PLTE", colors)] : []),
    ...(transparency ? [chunk("tRNS", transparency.data)] : []),
    chunk("IDAT", await deflateAsync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
  return { kind: "png", png: { width, height, bytes: png } };
}

type Chunk = { type: string; data: Uint8Array };

// Each chunk gives its data's length, its type, the data, then a checksum the bridge doesn't need,
// since it writes its own and zlib checks the rows. Reading stops at IEND, so whatever follows is
// left out, and a chunk the file cuts short keeps the data it has.
function readChunks(bytes: Uint8Array): Chunk[] {
  const view = viewOf(bytes);
  const chunks: Chunk[] = [];
  for (let at = signature.length; at + 8 <= bytes.length;) {
    const end = at + 12 + view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IEND") break;
    chunks.push({ type, data: bytes.subarray(at + 8, end - 4) });
    at = end;
  }
  return chunks;
}

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

// Decompressing throws past `size` bytes, so rows past the header's size are refused without
// holding them, while a stream that ends early gives fewer. Bytes after the stream are ignored.
async function inflateExactly(data: Uint8Array, size: number): Promise<Uint8Array | null> {
  try {
    const rows = await inflateAsync(data, { maxOutputLength: size });
    return rows.length < size ? null : rows;
  } catch {
    return null;
  }
}

/** Whether every row opens with one of the five filters, 0 to 4. */
function filtersKnown(rows: Uint8Array, rowLength: number): boolean {
  for (let at = 0; at < rows.length; at += rowLength) if (rows[at]! > 4) return false;
  return true;
}

/** Whether a palette holds whole colors, at least one and no more than `depth` bits can index. */
function paletteFits(colors: Uint8Array | undefined, depth: number): boolean {
  const count = (colors?.length ?? 0) / 3;
  return Number.isInteger(count) && count >= 1 && count <= 2 ** depth;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length);
  const view = viewOf(bytes);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

function join(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Bun.concatArrayBuffers(parts));
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function refused(reason: string): Rebuild {
  return { kind: "refused", reason };
}

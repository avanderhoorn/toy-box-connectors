import { crc32, deflateSync } from "node:zlib";

// PNG bytes for tests, written a chunk at a time. https://www.w3.org/TR/png-3/#5Chunk-layout

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const iend = chunk("IEND");

/** A blank `width` × `height` gray PNG. */
export function blankPng(width: number, height: number): Uint8Array {
  return png(ihdr(width, height, 8, 0), idat(new Uint8Array((width + 1) * height)), iend);
}

/** A PNG's signature, then `parts` as given, whether or not they make a valid PNG. */
export function png(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from([...signature, ...parts.flatMap((part) => [...part])]);
}

export function ihdr(
  width: number,
  height: number,
  depth: number,
  colorType: number,
  interlace = 0,
): Uint8Array {
  return chunk("IHDR", header(width, height, depth, colorType, interlace));
}

export function header(
  width: number,
  height: number,
  depth: number,
  colorType: number,
  interlace = 0,
): number[] {
  return [...uint32(width), ...uint32(height), depth, colorType, 0, 0, interlace];
}

export function idat(rows: ArrayLike<number>): Uint8Array {
  return chunk("IDAT", deflateSync(Uint8Array.from(rows)));
}

export function chunk(type: string, data: ArrayLike<number> = []): Uint8Array {
  const body = Uint8Array.from([...Buffer.from(type), ...Array.from(data)]);
  return Uint8Array.from([...uint32(data.length), ...body, ...uint32(crc32(body))]);
}

function uint32(value: number): number[] {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

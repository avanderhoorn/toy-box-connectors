import { expect, test } from "bun:test";
import { judgeImage, type ImageVerdict } from "./images";

const brokenHeader: ImageVerdict = {
  kind: "refused",
  reason: "its image header doesn't give its size",
};

test.each<[string, Uint8Array, ImageVerdict]>([
  [
    "a PNG's size is in its header",
    png(8000, 5000),
    { kind: "image", image: { format: "png", width: 8000, height: 5000 } },
  ],
  [
    "a JPEG's is in its first frame header, past fill bytes, markers with no length and an EXIF thumbnail's",
    jpeg(
      exif(frame(160, 120)),
      [0xff, 0xff],
      segment(0xc4, new Array<number>(17).fill(0)),
      [0xff, 0x01, 0xff, 0xd0],
      frame(4032, 3024),
    ),
    { kind: "image", image: { format: "jpeg", width: 4032, height: 3024 } },
  ],
  [
    "a progressive JPEG's too",
    jpeg(frame(1920, 1080, 0xc2)),
    { kind: "image", image: { format: "jpeg", width: 1920, height: 1080 } },
  ],
  [
    "an image of over 40 megapixels is refused",
    png(8000, 5001),
    { kind: "refused", reason: "it's over 40 megapixels, so ask for a crop" },
  ],
  ["and so is one whose height is left for later", jpeg(frame(4032, 0)), brokenHeader],
  [
    "and so is a PNG whose line breaks a transfer rewrote",
    png(1, 1).filter((_, index) => index !== 4),
    { kind: "refused", reason: "its bytes aren't a PNG or JPEG" },
  ],
])("%s", (_, bytes, verdict) => {
  expect(judgeImage(bytes)).toEqual(verdict);
});

test("a header cut short or out of order is refused, never read past its end", () => {
  const notIhdr = png(1, 1);
  notIhdr.set(Buffer.from("IDAT"), 12);
  for (const bytes of [
    png(1, 1).subarray(0, 23),
    notIhdr,
    jpeg([0xff, 0xe0]),
    jpeg(frame(1, 1)).subarray(0, 10),
    jpeg(segment(0xda, [1, 1, 0, 0, 0x3f, 0]), frame(1, 1)),
    jpeg([0xff, 0xd9, 0, 2], frame(1, 1)),
  ]) {
    expect(judgeImage(bytes)).toEqual(brokenHeader);
  }
});

/** A PNG's signature and IHDR, which is all the bridge reads of one. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set(Buffer.from("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6], 24);
  return bytes;
}

function jpeg(...parts: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...parts.flat()]);
}

function segment(code: number, body: number[]): number[] {
  const length = body.length + 2;
  return [0xff, code, length >> 8, length & 0xff, ...body];
}

/** A frame header for one 8-bit component, baseline unless `code` names another kind. */
function frame(width: number, height: number, code = 0xc0): number[] {
  return segment(code, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
}

/** An EXIF segment whose thumbnail has the frame header `thumbnail`. */
function exif(thumbnail: number[]): number[] {
  return segment(0xe1, [...Buffer.from("Exif\0\0"), 0xff, 0xd8, ...thumbnail, 0xff, 0xd9]);
}

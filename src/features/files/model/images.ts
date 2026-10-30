// Images, as their own bytes describe them.
//
// A file's type and name are whatever its uploader chose, so the bridge goes by an image's
// signature and header alone. A PNG gives its size in IHDR, the chunk every PNG starts with. A
// JPEG gives its size in its first frame header, found by walking its segments by their lengths,
// which steps over the frame header of the thumbnail an EXIF segment can hold. An image over 40
// megapixels is refused, which still takes a 6K or 8K screenshot and bounds what the lead's
// viewer, in a process every agent shares, has to decode.
// https://www.w3.org/TR/png-3/#5DataRep
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf, B.1.1 and B.2.2

export type ImageFormat = "png" | "jpeg";
/** An image's format and size in pixels. */
export type Image = { format: ImageFormat; width: number; height: number };
/** An image, or why the bridge won't show it. A reason follows "can't be read since". */
export type ImageVerdict = { kind: "image"; image: Image } | { kind: "refused"; reason: string };

const maxPixels = 40_000_000;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpegSignature = [0xff, 0xd8];

/** The image `bytes` hold, judged by their signature and header. */
export function judgeImage(bytes: Uint8Array): ImageVerdict {
  const format = startsWith(bytes, pngSignature)
    ? "png"
    : startsWith(bytes, jpegSignature)
      ? "jpeg"
      : null;
  if (!format) return refused("its bytes aren't a PNG or JPEG");
  const size = format === "png" ? pngSize(bytes) : jpegSize(bytes);
  if (!size || size.width * size.height === 0)
    return refused("its image header doesn't give its size");
  if (size.width * size.height > maxPixels)
    return refused("it's over 40 megapixels, so ask for a crop");
  return { kind: "image", image: { format, ...size } };
}

type Size = { width: number; height: number };

// IHDR's length and type, then its width and height, follow the signature.
function pngSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = viewOf(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Each segment starts with a marker, 0xFF and a code, which any number of 0xFF can pad. Most codes
// are followed by the segment's length, which counts itself. A frame header holds the precision,
// then the height and width.
function jpegSize(bytes: Uint8Array): Size | null {
  const view = viewOf(bytes);
  let at = jpegSignature.length;
  while (bytes[at] === 0xff) {
    while (bytes[at] === 0xff) at++;
    const code = bytes[at++];
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) continue;
    // The scan's data, or the end, comes before any frame header.
    if (code === 0xda || code === 0xd9 || at + 2 > bytes.length) return null;
    if (frameCodes.has(code)) {
      return at + 7 > bytes.length
        ? null
        : { height: view.getUint16(at + 3), width: view.getUint16(at + 5) };
    }
    at += view.getUint16(at);
  }
  return null;
}

/** SOF0 to SOF15, leaving out DHT, JPG and DAC, which share their range. */
const frameCodes: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function refused(reason: string): ImageVerdict {
  return { kind: "refused", reason };
}

// The images the lead views.
//
// The lead's viewer opens only files, so the bridge writes each image the lead reads to a file of
// its own in the viewing folder, inside the data folder, where only the owner can open it. The file
// takes a name the bridge makes up, never one from Slack, and lasts ten minutes, plenty for the
// lead to view it. The bridge looks for older images every minute by the wall clock, so a Mac that
// slept still deletes them on time, and it deletes them all when it starts and when it stops, so
// an image outlives `serve` only after a crash, until the bridge starts again. It deletes only
// names it makes, so it never removes a file it didn't write.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageFormat } from "@files/model/images";
import { log } from "@/shared/log";

export interface ViewingFolder {
  /** Writes `bytes`, an image in `format` that `ref` names, and returns the path to view it at. */
  show(ref: number, format: ImageFormat, bytes: Uint8Array): Promise<string>;
  /** Stops looking for older images, and deletes them all. */
  close(): void;
}

const lifetime = 10 * 60_000;
const extensions: Record<ImageFormat, string> = { png: "png", jpeg: "jpg" };
const imageName = /^f\d+-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(?:png|jpg)$/;

/**
 * Opens the viewing folder at `path`, deleting any image a crash left there. A failure to delete
 * an image on time goes to `onError`, since the owner was promised it would go.
 */
export function openViewingFolder(path: string, onError: (error: unknown) => void): ViewingFolder {
  deleteImages(path);
  const timer = setInterval(() => {
    try {
      deleteImages(path, Date.now() - lifetime);
    } catch (error) {
      log("Couldn't delete the images the lead viewed:", error);
      onError(error);
    }
  }, 60_000);
  return {
    async show(ref, format, bytes) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const file = join(path, `f${ref}-${crypto.randomUUID()}.${extensions[format]}`);
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      return file;
    },
    close() {
      clearInterval(timer);
      deleteImages(path);
    },
  };
}

/** Deletes the images in `folder` written before `writtenBefore`, and nothing else. */
function deleteImages(folder: string, writtenBefore = Infinity): void {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name);
    if (entry.isFile() && imageName.test(entry.name) && statSync(file).mtimeMs < writtenBefore) {
      unlinkSync(file);
    }
  }
}

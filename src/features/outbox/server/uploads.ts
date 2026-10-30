// The images a command uploads for the post it queues.
//
// A message shows an image only once Slack has processed it as a file, so the command uploads each
// image before it queues the post, as a file only the bot can see, and the post names the files
// when it goes out. Each image is rebuilt from its pixels first, and the outbox checks the post
// before anything uploads, then again as it queues it. A file is owed a delete from the moment
// Slack names it until the queued post shows it, so one no post shows is deleted, even after a
// crash. The command starts no Slack work past a deadline, so it answers within the CLI's wait.
// https://docs.slack.dev/messaging/working-with-files/#upload

import type { BridgeDatabase } from "@bridge/server/database";
import { rebuildPng } from "@files/model/png";
import { judgeCompletion, judgeProcessing, judgeUploadTicket } from "@slackapi/model/uploads";
import type { BotClient } from "@slackapi/server/botClient";
import type { PostImage } from "../model/payload";
import { OutboxRefusedError, type OutboxItem } from "./database";
import { attachFiles, oweFileDeletes } from "./files";

/** An image the lead gave a post: its file's bytes, and what it shows. */
export type LeadImage = { bytes: Uint8Array; alt: string };
export type UploadTimings = { now?: () => number; sleep?: (ms: number) => Promise<unknown> };

// How long a command may keep at a post's images. An upload it starts by then gives up within 20
// seconds, and a call within 10, so the command still answers within the CLI's wait.
const uploadDeadlineMs = 30_000;
// A file is owed a delete due long after its command must have ended, so the outbox deletes one
// before its post is queued only when a crash left it behind.
const abandonedAfterMs = 5 * 60_000;
// The pauses between looks at whether Slack has processed the files, the last repeating.
const processingPauses = [250, 500, 1000, 2000];

/**
 * Uploads `images` and queues the post that shows them with `queue`, which refuses as the outbox
 * does before anything uploads. Every file no queued post shows is owed a delete.
 */
export async function queueWithImages<Queued extends { post: OutboxItem }>(
  database: BridgeDatabase,
  bot: BotClient | null,
  images: readonly LeadImage[],
  queue: (tx: Bun.SQL, images: readonly PostImage[]) => Promise<Queued>,
  { now = Date.now, sleep = Bun.sleep }: UploadTimings = {},
): Promise<Queued> {
  const shown = images.map(({ alt }) => ({ alt }));
  if (!images.length) return database.write((tx) => queue(tx, shown));
  if (bot === null) throw new OutboxRefusedError("Slack isn't active.");
  await tryQueue(database, (tx) => queue(tx, shown));
  const pngs = await rebuildImages(images);
  const deadline = now() + uploadDeadlineMs;
  /** Refuses image `index` once the deadline has passed, saying how Slack was slow. */
  const inTime = (index: number, slow = "Slack took too long") => {
    if (now() >= deadline) throw imageRefused(index, `${slow}, so try again shortly`);
  };
  const fileIds: string[] = [];
  try {
    for (const [index, png] of pngs.entries()) {
      inTime(index);
      const ticket = judgeUploadTicket(
        await bot.call("files.getUploadURLExternal", (client) =>
          client.apiCall("files.getUploadURLExternal", {
            filename: `image-${index + 1}.png`,
            length: png.length,
            alt_txt: shown[index]!.alt,
          }),
        ),
      );
      if (ticket.kind === "refused") throw imageRefused(index, ticket.reason);
      await database.write((tx) =>
        oweFileDeletes(tx, [ticket.fileId], now() + abandonedAfterMs, now()),
      );
      fileIds.push(ticket.fileId);
      inTime(index);
      const sent = await bot.upload({ url: ticket.url, bytes: png });
      if (sent.kind === "refused") throw imageRefused(index, sent.reason);
      inTime(index);
      // Naming no channel keeps the file the bot's until a message shows it.
      const completion = judgeCompletion(
        await bot.call("files.completeUploadExternal", (client) =>
          client.files.completeUploadExternal({ files: [{ id: ticket.fileId }] }),
        ),
      );
      if (completion.kind === "refused") throw imageRefused(index, completion.reason);
    }
    await awaitProcessing(
      bot,
      fileIds,
      (index) => inTime(index, "Slack took too long to process it"),
      sleep,
    );
    return await database.write(async (tx) => {
      const queued = await queue(tx, shown);
      await attachFiles(tx, queued.post.id, fileIds);
      return queued;
    });
  } catch (error) {
    if (fileIds.length) await database.write((tx) => oweFileDeletes(tx, fileIds, now(), now()));
    throw error;
  }
}

/** Runs `queue` and undoes what it wrote, so a post the outbox refuses uploads nothing. */
async function tryQueue(
  database: BridgeDatabase,
  queue: (tx: Bun.SQL) => Promise<unknown>,
): Promise<void> {
  const undo = new Error("Undo the post queued to check it.");
  try {
    await database.write(async (tx) => {
      await queue(tx);
      throw undo;
    });
  } catch (error) {
    if (error !== undo) throw error;
  }
}

/** Each image as a PNG holding only its pixels, refusing the first that isn't one. */
async function rebuildImages(images: readonly LeadImage[]): Promise<Uint8Array[]> {
  const pngs: Uint8Array[] = [];
  for (const [index, { bytes }] of images.entries()) {
    const rebuilt = await rebuildPng(bytes);
    if (rebuilt.kind === "refused")
      throw new OutboxRefusedError(`Image ${index + 1} ${rebuilt.reason}.`);
    pngs.push(rebuilt.png.bytes);
  }
  return pngs;
}

/** Waits until Slack has processed each of `fileIds`, so a message can show it. */
async function awaitProcessing(
  bot: BotClient,
  fileIds: readonly string[],
  inTime: (index: number) => void,
  sleep: (ms: number) => Promise<unknown>,
): Promise<void> {
  let waiting = [...fileIds.keys()];
  for (let look = 0; ; look += 1) {
    const unprocessed: number[] = [];
    for (const index of waiting) {
      inTime(index);
      const processing = judgeProcessing(
        await bot.call("files.info", (client) => client.files.info({ file: fileIds[index]! })),
      );
      if (processing.kind === "refused") throw imageRefused(index, processing.reason);
      if (processing.kind === "processing") unprocessed.push(index);
    }
    if (!unprocessed.length) return;
    waiting = unprocessed;
    await sleep(processingPauses[Math.min(look, processingPauses.length - 1)]!);
  }
}

function imageRefused(index: number, reason: string): OutboxRefusedError {
  return new OutboxRefusedError(`Image ${index + 1} couldn't be uploaded since ${reason}.`);
}

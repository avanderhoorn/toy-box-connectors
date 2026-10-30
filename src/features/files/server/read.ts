// Reading a shared file for the lead.
//
// The rule runs on the allowlist as it is when the lead reads, by each person's canonical ID, since
// that's how the allowlist holds them. A file's bytes come from Slack only once files.info's fresh
// facts pass the rule too, so a file deleted, unshared or swapped since the ledger stored it, or
// whose uploader left the allowlist, isn't read.

import { judgeImage, type Image } from "@files/model/images";
import {
  judgeFile,
  type FileFormat,
  type FileVerdict,
  type SettledVerdict,
} from "@files/model/readable";
import { readText } from "@files/model/text";
import {
  judgeFileInfo,
  type FileFacts,
  type FileInfoVerdict,
  type SlackFile,
  type WholeFile,
} from "@slackapi/model/files";
import type { SlackTs } from "@slackapi/model/ts";
import type { BotClient } from "@slackapi/server/botClient";
import { canonicalUserId } from "@slackapi/server/users";

/** What the lead reads of a file, or why it can't. A reason follows "can't be read since". */
export type FileContent =
  | { kind: "text"; text: string }
  | { kind: "image"; image: Image; bytes: Uint8Array }
  | { kind: "refused"; reason: string };

/** Whether the lead may read `file`, which `sharerId` shared, by who's on `allowlist` now. */
export function judgeSharedFile(
  sql: Bun.SQL,
  allowlist: ReadonlySet<string>,
  shared: { sharerId: string | null; file: WholeFile },
): Promise<SettledVerdict>;
export function judgeSharedFile(
  sql: Bun.SQL,
  allowlist: ReadonlySet<string>,
  shared: { sharerId: string | null; file: SlackFile },
): Promise<FileVerdict>;
export async function judgeSharedFile(
  sql: Bun.SQL,
  allowlist: ReadonlySet<string>,
  { sharerId, file }: { sharerId: string | null; file: SlackFile },
): Promise<FileVerdict> {
  const allowed = new Set<string>();
  for (const userId of [sharerId, file.whole ? file.uploaderId : null]) {
    if (userId !== null && allowlist.has(await canonicalUserId(sql, userId))) allowed.add(userId);
  }
  return judgeFile(file, sharerId, (userId) => allowed.has(userId));
}

/** What files.info says now of file `fileId`, which the message at `share` shared. */
export async function fetchFileFacts(
  bot: BotClient,
  fileId: string,
  share: { channelId: string; ts: SlackTs },
): Promise<FileInfoVerdict> {
  const call = await bot.call("files.info", (client) => client.files.info({ file: fileId }));
  return judgeFileInfo(call, share);
}

/**
 * The file `facts` describes, downloaded now and read as `format` says. An image goes by its
 * signature, whatever type the file claims.
 */
export async function readFile(
  bot: BotClient,
  facts: FileFacts,
  format: FileFormat,
): Promise<FileContent> {
  const download = await bot.download(facts);
  if (download.kind === "refused") return download;
  if (format === "text") return readText(download.bytes);
  const verdict = judgeImage(download.bytes);
  return verdict.kind === "image" ? { ...verdict, bytes: download.bytes } : verdict;
}

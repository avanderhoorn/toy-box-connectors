// file reads a shared file for the lead: a page of a text file's text, or an image the lead views at
// a path the bridge writes. The readable rule judges the ledger's description of the file before
// Slack hears of it, and files.info's fresh one before the download, each time by the allowlist as
// it is then. Like inbox, file posts nothing, so it reads while the link is paused or suspended.

import { readSharedFile, type SharedFile } from "@activity/server/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { fileTextPage, presentFileAnswer, type FileAnswer } from "@commands/model/file";
import { CommandRefusedError } from "@commands/model/protocol";
import { fileName } from "@commands/model/slackText";
import { fetchFileFacts, judgeSharedFile, readFile } from "@files/server/read";
import type { ViewingFolder } from "@files/server/viewing";
import type { BotClient } from "@slackapi/server/botClient";
import { canonicalUserId } from "@slackapi/server/users";
import { namedPerson, readPersonNames } from "./inbox";
import { readCallerLink, type CallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type FileCommandOptions = {
  database: BridgeDatabase;
  /** Slack's Web API, or null when the bridge has no Slack tokens. */
  bot: BotClient | null;
  viewing: ViewingFolder;
};

export function fileCommand({
  database,
  bot,
  viewing,
}: FileCommandOptions): CommandHandler<"file"> {
  return async ({ file: id, page }, { channelId }) => {
    const reference = `f${id}`;
    const unreadable = (reason: string) =>
      new CommandRefusedError(`${reference} can't be read since ${reason}.`);
    const { link, shared } = await database.read(async (sql) => {
      const found = await readLinkFile(sql, channelId, id);
      const verdict = await judgeSharedFile(sql, found.link.allowlist, found.shared);
      if (verdict.kind === "refused") throw unreadable(verdict.reason);
      return found;
    });
    if (bot === null) throw unreadable("Slack isn't active");
    const share = { channelId: link.slackChannelId, ts: shared.ts };
    const info = await fetchFileFacts(bot, shared.file.id, share);
    if (info.kind === "refused") throw unreadable(info.reason);
    const facts = info.file;
    const { format, sharer, uploader } = await database.read(async (sql) => {
      const now = await readLinkFile(sql, channelId, id);
      const fresh = { sharerId: now.shared.sharerId, file: facts };
      const verdict = await judgeSharedFile(sql, now.link.allowlist, fresh);
      if (verdict.kind === "refused") throw unreadable(verdict.reason);
      // Canonical, so someone who shared a file they uploaded under another ID uploaded it too.
      const sharerId = fresh.sharerId === null ? null : await canonicalUserId(sql, fresh.sharerId);
      const uploaderId = await canonicalUserId(sql, facts.uploaderId);
      const names = await readPersonNames(sql, [], sharerId, uploaderId);
      return {
        format: verdict.format,
        sharer: namedPerson(names, sharerId),
        uploader: namedPerson(names, uploaderId),
      };
    });
    const content = await readFile(bot, facts, format);
    if (content.kind === "refused") throw unreadable(content.reason);
    const about = { file: reference, name: fileName(facts.name), sharer, uploader };
    let answer: FileAnswer;
    if (content.kind === "image") {
      const path = await viewing.show(id, content.image.format, content.bytes);
      answer = { ...about, ...content.image, path };
    } else {
      const shown = fileTextPage(content.text, page);
      if (shown === null) {
        throw new CommandRefusedError(
          `${reference} has no page ${page}. Run \`toy-box-slack file ${reference}\` to read it from the start.`,
        );
      }
      answer = { ...about, format: "text", ...shown };
    }
    return { result: answer, text: presentFileAnswer(answer) };
  };
}

/**
 * File `id` of the caller's link. Another link's file is refused like a missing one, so a lead
 * learns nothing of it.
 */
async function readLinkFile(
  sql: Bun.SQL,
  channelId: string | null,
  id: number,
): Promise<{ link: CallerLink; shared: SharedFile }> {
  const link = await readCallerLink(sql, channelId);
  const shared = await readSharedFile(sql, link.slackChannelId, id);
  if (shared === null) {
    throw new CommandRefusedError(
      `This channel has no file f${id}. \`toy-box-slack inbox\` and \`toy-box-slack activity\` list the files people share.`,
    );
  }
  return { link, shared };
}

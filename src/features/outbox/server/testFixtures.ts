import { onTestFinished } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { blankPng } from "@files/model/testFixtures";
import { readChannelLink } from "@links/server/database";
import { createStoredLink } from "@links/server/testFixtures";
import type { Request } from "@requests/model/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import type { PostImage } from "../model/payload";
import { renderMarkdown } from "../model/rendering";
import { queuePost, queueReply, readOutboxItem } from "./database";
import { attachFiles, readDueDeletions } from "./files";
import { createPostDelivery } from "./posts";
import type { PostThread } from "./threads";

export function createStoredOutboxItem(
  database: BridgeDatabase,
  number: number,
  columns: Record<string, string | number | null> = {},
) {
  const rendered = renderMarkdown("An answer.");
  if (rendered.kind !== "rendered") throw new Error("Expected render");
  return database.write(
    (tx) =>
      tx`INSERT INTO outbox ${tx({
        id: `item-${number}`,
        number,
        link_id: "link",
        request_id: 1,
        kind: "reply",
        channel_id: "C-link",
        thread_ts: "1700000100.000100",
        payload: JSON.stringify({ text: "An answer.", mentions: [], images: [] }),
        payload_hash: hash(JSON.stringify(rendered.message)),
        state: "queued",
        created_at: 0,
        updated_at: 0,
        ...columns,
      })}`,
  );
}

/**
 * What version 5 kept for an item until it went out, and named it by: the message its text
 * rendered to, whose block opens with any people it mentions, and what each image shows.
 */
export function version5Payload(text: string, block = text, images?: PostImage[]): string {
  return JSON.stringify({
    text,
    blocks: [{ type: "markdown", text: block }],
    mrkdwn: false,
    parse: "none",
    unfurl_links: false,
    unfurl_media: false,
    ...(images && { images }),
  });
}

/**
 * A post version 5 queued and what the lead asked it to say: it shows a chart and mentions Bob
 * before Alice, an order no sort would give them.
 */
export const version5Post = {
  asked: {
    text: "Shipped **1.2**. Ask <@W0BOB> or @channel.",
    mentions: ["U0BOB", "U0ALICE"],
    images: [{ alt: "Build minutes" }],
  },
  payload: version5Payload(
    "Shipped **1.2**. Ask &lt;@W0BOB> or @\u200bchannel.",
    "<@U0BOB> <@U0ALICE>\n\nShipped **1.2**. Ask &lt;@W0BOB> or @\u200bchannel.",
    [{ alt: "Build minutes" }],
  ),
};

/** Stores an item as version 5 kept it, as `payload`, under the hash of those bytes it gave it. */
export function createVersion5Item(
  database: BridgeDatabase,
  number: number,
  payload: string,
  columns: Record<string, string | number | null> = {},
) {
  return createStoredOutboxItem(database, number, {
    payload,
    payload_hash: hash(payload),
    ...columns,
  });
}

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** A link and a seen request in it, which `asked` changes, such as to open it on a reply in a thread. */
export async function createOutboxWorld(asked: Partial<Request> = {}) {
  let at = 1_700_000_200_000;
  const now = () => at;
  const database = await openTestDatabase();
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  onTestFinished(() => slack.stop());
  slack.addChannel({
    id: "C-link",
    is_private: true,
    shared_team_ids: ["T-home"],
    members: ["U-owner", "U-bot"],
  });
  await createStoredInstallation(database);
  await createStoredLink(database);
  await database.write(
    (tx) => tx`
    INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)
  `,
  );
  const request = await createStoredRequest(database, {
    state: "seen",
    touchedAt: now(),
    createdAt: now(),
    ...asked,
  });
  for (const ts of new Set([request.rootTs, request.sourceTs])) {
    slack.setMessage("C-link", { type: "message", ts, user: "U-owner", text: "Question" });
  }
  const bot = createBotClient(slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs: 50,
    now,
  });
  return {
    database,
    slack,
    bot,
    request,
    now,
    advance(ms: number) {
      at += ms;
    },
    /** Queues a reply, showing an image the bot uploaded as each of `fileIds`, as reply does. */
    queue: (text = "A **safe answer**.", fileIds: readonly string[] = []) =>
      database.write(async (tx) => {
        for (const id of fileIds)
          slack.addFile(blankPng(1, 1), {
            user: "U-bot",
            id,
            name: "image-1.png",
            mimetype: "image/png",
          });
        const images = fileIds.map((id) => ({ alt: `Chart ${id}` }));
        const item = await queueReply(tx, { requestId: request.id, text, images }, now());
        await attachFiles(tx, item.id, fileIds);
        return item;
      }),
    /** Queues a post the owner asked for, at the top of the channel or in `thread`. */
    queuePost: (thread?: PostThread, text = "Shipped **1.2**.", mentions?: readonly string[]) =>
      database.write(async (tx) => {
        const link = await readChannelLink(tx, "C-link");
        return queuePost(tx, { link: link!, thread, text, mentions }, now());
      }),
    read: (id: string) => database.read((sql) => readOutboxItem(sql, id)),
    /** The deletes the bridge owes Slack by now. */
    owed: () => database.read((sql) => readDueDeletions(sql, now())),
    post: createPostDelivery(database, bot, { now }).post,
  };
}

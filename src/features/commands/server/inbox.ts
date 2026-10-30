// Inbox reads the waiting requests and marks the pending ones it shows seen in one transaction, so
// a request that changes meanwhile stays pending for the next wake.

import type { AuthorRole } from "@activity/model/ledger";
import { readSharedFiles } from "@activity/server/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { listFile, type ListedFile } from "@commands/model/file";
import {
  inboxOrder,
  inboxThread,
  MESSAGE_LIMIT,
  presentInbox,
  type Inbox,
  type InboxMessage,
  type InboxRequest,
} from "@commands/model/inbox";
import {
  cutText,
  mentionedUsers,
  permalink,
  personName,
  renderSlackText,
  type SlackNames,
} from "@commands/model/slackText";
import { judgeSharedFile } from "@files/server/read";
import type { ChannelLink } from "@links/server/database";
import type { OutboxWorker } from "@outbox/server";
import { serveRequest } from "@requests/model/lifecycle";
import { readActiveRequests, saveRequest, type StoredRequest } from "@requests/server/database";
import { readSlackPersonName } from "@slackapi/server/users";
import { isPending } from "@wakes/model";
import { readCallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type InboxCommandOptions = {
  database: BridgeDatabase;
  /** The Slack workspace's URL, once Slack has said it, for permalinks. */
  workspaceUrl: () => string | null;
  acknowledge?: OutboxWorker["acknowledge"];
};

/** A message the bridge keeps text for, as commands read it. */
export type MessageRow = {
  ts: string;
  userId: string | null;
  role: AuthorRole;
  edited: number;
  text: string;
};

export function inboxCommand({
  database,
  workspaceUrl,
  acknowledge,
}: InboxCommandOptions): CommandHandler<"inbox"> {
  return async ({ limit }, { channelId, at }) => {
    const seen: StoredRequest[] = [];
    const inbox = await database.write(async (transaction): Promise<Inbox> => {
      const link = await readCallerLink(transaction, channelId);
      const waiting = inboxOrder(await readActiveRequests(transaction, link.id));
      const requests: InboxRequest[] = [];
      for (const request of waiting.slice(0, limit)) {
        requests.push(await readInboxRequest(transaction, link, request, workspaceUrl()));
        if (isPending(request)) {
          await saveRequest(transaction, serveRequest(request, at));
          seen.push(request);
        }
      }
      return {
        channel: link.channel,
        linkStatus: link.status,
        requests,
        more: waiting.length - requests.length,
      };
    });
    acknowledge?.(seen);
    return { result: inbox, text: presentInbox(inbox, at) };
  };
}

async function readInboxRequest(
  sql: Bun.SQL,
  link: ChannelLink,
  request: StoredRequest,
  workspaceUrl: string | null,
): Promise<InboxRequest> {
  // Deleted messages and those of people the link doesn't observe keep no text.
  const thread = await sql<MessageRow[]>`
    SELECT ts, user_id AS userId, author_role AS role, edited_ts IS NOT NULL AS edited, text
    FROM messages
    WHERE channel_id = ${request.channelId} AND text IS NOT NULL
      AND (ts = ${request.rootTs} OR thread_ts = ${request.rootTs})
    ORDER BY ts
  `;
  const own = await sql<{ ts: string }[]>`
    SELECT ts FROM request_messages WHERE request_id = ${request.id}
  `;
  const { messages, leftOut } = inboxThread(thread, new Set(own.map(({ ts }) => ts)));
  const names = await readPersonNames(sql, messages, request.requesterUserId);
  const files = await readListedFiles(sql, link, messages);
  // A request inbox shows is waiting on the lead, so a reply it has can only be one that failed.
  const [reply] = await sql<{ error: string | null }[]>`
    SELECT error FROM outbox WHERE request_id = ${request.id} AND kind = 'reply'
  `;
  return {
    id: request.id,
    requester: namedPerson(names, request.requesterUserId),
    state: request.state,
    attention: request.attention,
    replyError: reply?.error ?? null,
    createdAt: request.createdAt,
    touchedAt: request.touchedAt,
    permalink: permalink(workspaceUrl, request),
    messages: messages.map((message) => messageFromRow(message, names, files)),
    leftOut,
  };
}

/**
 * `row` as the lead reads it, with people named as `names` holds them, long text cut, and the
 * files it shares as `files` lists them by message.
 */
export function messageFromRow(
  { ts, userId, role, edited, text }: MessageRow,
  names: SlackNames,
  files: ReadonlyMap<string, ListedFile[]>,
): InboxMessage {
  return {
    ts,
    author: namedPerson(names, userId),
    role,
    edited: edited === 1,
    ...cutText(renderSlackText(text, names), MESSAGE_LIMIT),
    files: files.get(ts) ?? [],
  };
}

/** Someone by the name `names` holds for them, or "someone" when Slack named no one. */
export function namedPerson<UserId extends string | null>(names: SlackNames, userId: UserId) {
  return { userId, name: userId === null ? "someone" : personName(names.get(userId), userId) };
}

/** The files `messages` of `link`'s channel share, by message, as its lead may read them now. */
export async function readListedFiles(
  sql: Bun.SQL,
  link: Pick<ChannelLink, "slackChannelId" | "allowlist">,
  messages: readonly { ts: string }[],
): Promise<Map<string, ListedFile[]>> {
  const listed = new Map<string, ListedFile[]>();
  const tsList = messages.map(({ ts }) => ts);
  for (const shared of await readSharedFiles(sql, link.slackChannelId, tsList)) {
    const verdict = await judgeSharedFile(sql, link.allowlist, shared);
    listed.set(shared.ts, [
      ...(listed.get(shared.ts) ?? []),
      listFile(shared.id, shared.file, verdict),
    ]);
  }
  return listed;
}

/** The names the bridge stored for `people`, and for who wrote or is mentioned in `messages`. */
export async function readPersonNames(
  sql: Bun.SQL,
  messages: MessageRow[],
  ...people: (string | null)[]
): Promise<SlackNames> {
  const names = new Map<string, string>();
  const ids = messages.flatMap(({ userId, text }) => [userId, ...mentionedUsers(text)]);
  for (const userId of new Set([...people, ...ids].filter((id) => id !== null))) {
    const name = await readSlackPersonName(sql, userId);
    if (name) names.set(userId, name);
  }
  return names;
}

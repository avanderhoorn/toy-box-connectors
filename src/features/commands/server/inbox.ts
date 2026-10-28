// Inbox reads the waiting requests and marks the pending ones it shows seen in one transaction, so
// a request that changes meanwhile stays pending for the next wake.

import type { AuthorRole } from "@activity/model/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { inboxOrder, presentInbox, type Inbox, type InboxRequest } from "@commands/model/inbox";
import {
  mentionedUsers,
  permalink,
  personName,
  renderSlackText,
  type SlackNames,
} from "@commands/model/slackText";
import type { OutboxWorker } from "@outbox/server";
import { serveRequest } from "@requests/model/lifecycle";
import { readActiveRequests, saveRequest, type StoredRequest } from "@requests/server/database";
import { readSlackPersonName } from "@slackapi/server/users";
import { isPending } from "@wakes/model";
import type { WakeScheduler } from "@wakes/server";
import { readCallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type InboxCommandOptions = {
  database: BridgeDatabase;
  wakes: Pick<WakeScheduler, "reconsider">;
  /** The Slack workspace's URL, once Slack has said it, for permalinks. */
  workspaceUrl: () => string | null;
  acknowledge?: OutboxWorker["acknowledge"];
};

type ThreadMessage = {
  ts: string;
  userId: string | null;
  role: AuthorRole;
  edited: number;
  text: string;
};

export function inboxCommand({
  database,
  wakes,
  workspaceUrl,
  acknowledge,
}: InboxCommandOptions): CommandHandler<"inbox"> {
  return async ({ limit }, { caller, at }) => {
    const seen: StoredRequest[] = [];
    const inbox = await database.write(async (transaction): Promise<Inbox> => {
      const link = await readCallerLink(transaction, caller);
      const waiting = inboxOrder(await readActiveRequests(transaction, link.id));
      const requests: InboxRequest[] = [];
      for (const request of waiting.slice(0, limit)) {
        requests.push(await readInboxRequest(transaction, request, workspaceUrl()));
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
    wakes.reconsider();
    acknowledge?.(seen);
    return { result: inbox, text: presentInbox(inbox, at) };
  };
}

async function readInboxRequest(
  sql: Bun.SQL,
  request: StoredRequest,
  workspaceUrl: string | null,
): Promise<InboxRequest> {
  // Deleted messages and those of people the link doesn't observe keep no text.
  const thread = await sql<ThreadMessage[]>`
    SELECT ts, user_id AS userId, author_role AS role, edited_ts IS NOT NULL AS edited, text
    FROM messages
    WHERE channel_id = ${request.channelId} AND text IS NOT NULL
      AND (ts = ${request.rootTs} OR thread_ts = ${request.rootTs})
    ORDER BY ts
  `;
  const names = await readPersonNames(sql, [
    request.requesterUserId,
    ...thread.flatMap(({ userId, text }) => [userId, ...mentionedUsers(text)]),
  ]);
  const person = <UserId extends string | null>(userId: UserId) => ({
    userId,
    name: userId === null ? "someone" : personName(names.get(userId), userId),
  });
  return {
    id: request.id,
    requester: person(request.requesterUserId),
    state: request.state,
    attention: request.attention,
    createdAt: request.createdAt,
    touchedAt: request.touchedAt,
    permalink: permalink(workspaceUrl, request),
    messages: thread.map(({ userId, edited, text, ...message }) => ({
      ...message,
      author: person(userId),
      edited: edited === 1,
      text: renderSlackText(text, names),
    })),
  };
}

async function readPersonNames(sql: Bun.SQL, userIds: (string | null)[]): Promise<SlackNames> {
  const names = new Map<string, string>();
  for (const userId of new Set(userIds.filter((userId) => userId !== null))) {
    const name = await readSlackPersonName(sql, userId);
    if (name) names.set(userId, name);
  }
  return names;
}

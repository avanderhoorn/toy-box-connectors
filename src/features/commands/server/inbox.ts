// The inbox command.
//
// Inbox reads the waiting requests and marks the pending ones it shows seen in one transaction, so
// a request that changes meanwhile stays pending for the next wake. Then the scheduler decides
// again, since what it was waking the lead for has been served.

import type { BridgeDatabase } from "@bridge/server/database";
import {
  inboxOrder,
  presentInbox,
  type AuthorRole,
  type Inbox,
  type InboxRequest,
} from "@commands/model/inbox";
import {
  NAME_LIMIT,
  oneLine,
  personName,
  renderSlackText,
  slackReferences,
  type SlackNames,
} from "@commands/model/slackText";
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
}: InboxCommandOptions): CommandHandler<"inbox"> {
  return async ({ limit }, { caller, at }) => {
    const inbox = await database.write(async (transaction): Promise<Inbox> => {
      const link = await readCallerLink(transaction, caller);
      const waiting = inboxOrder(await readActiveRequests(transaction, link.id));
      const requests: InboxRequest[] = [];
      for (const request of waiting.slice(0, limit)) {
        requests.push(await readInboxRequest(transaction, request, workspaceUrl()));
        if (isPending(request)) await saveRequest(transaction, serveRequest(request, at));
      }
      const [channel] = await transaction<{ name: string | null }[]>`
        SELECT name FROM channel_info WHERE channel_id = ${link.slackChannelId}
      `;
      return {
        channel: `#${oneLine(channel?.name ?? link.slackChannelId, NAME_LIMIT)}`,
        linkStatus: link.status,
        requests,
        more: waiting.length - requests.length,
      };
    });
    wakes.reconsider();
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
  const names = await readNames(
    sql,
    [request.requesterUserId, ...thread.map((m) => m.userId)],
    thread,
  );
  const person = <UserId extends string | null>(userId: UserId) => ({
    userId,
    name: userId === null ? "someone" : personName(names.people.get(userId) ?? null, userId),
  });
  return {
    id: request.id,
    requester: person(request.requesterUserId),
    state: request.state,
    attention: request.attention,
    createdAt: request.createdAt,
    touchedAt: request.touchedAt,
    permalink: permalink(workspaceUrl, request),
    messages: thread.map((message) => ({
      ts: message.ts,
      author: person(message.userId),
      role: message.role,
      edited: message.edited === 1,
      text: renderSlackText(message.text, names),
    })),
  };
}

async function readNames(
  sql: Bun.SQL,
  userIds: readonly (string | null)[],
  messages: readonly ThreadMessage[],
): Promise<SlackNames> {
  const references = messages.map((message) => slackReferences(message.text));
  const people = new Map<string, string>();
  for (const userId of new Set([...userIds, ...references.flatMap((r) => r.people)])) {
    const name = userId === null ? null : await readSlackPersonName(sql, userId);
    if (name !== null) people.set(userId!, name);
  }
  const channels = new Map<string, string>();
  for (const channelId of new Set(references.flatMap((r) => r.channels))) {
    const [channel] = await sql<{ name: string | null }[]>`
      SELECT name FROM channel_info WHERE channel_id = ${channelId}
    `;
    if (channel?.name) channels.set(channelId, channel.name);
  }
  return { people, channels };
}

function permalink(workspaceUrl: string | null, request: StoredRequest): string | null {
  if (workspaceUrl === null) return null;
  const workspace = workspaceUrl.endsWith("/") ? workspaceUrl : `${workspaceUrl}/`;
  const message = `${workspace}archives/${request.channelId}/p${request.sourceTs.replace(".", "")}`;
  return request.sourceTs === request.rootTs ? message : `${message}?thread_ts=${request.rootTs}`;
}

// The threads a reply or post can go in.
//
// A post names a thread by a request in it, such as r14, or by the link's own top-level post it's
// under, such as o31, never by a raw ts, and only in its own link, so another link's request or post
// reads like one that doesn't exist. A request's thread takes posts only while the request isn't
// cancelled and its requester is still allowed, the guard its reply keeps, and a post's thread takes
// them only while that post is in Slack. The outbox checks a post's thread when it's queued and every
// reply's and post's thread again before sending it, and activity names each thread a post can go in
// by the check it queues with, so it never offers a thread that post would refuse.

import type { ChannelLink } from "@links/server/database";
import { readRequest, readRequestsInThreads, type StoredRequest } from "@requests/server/database";
import type { SlackTs } from "@slackapi/model/ts";
import { canonicalUserId } from "@slackapi/server/users";
import type { OutboxItem, OutboxState } from "./database";

/** A thread as the lead names it, by a request in it or by the link's own post it's under. */
export type PostThread = { request: number } | { post: number };

/** The thread a post goes in, and the request it was named by, if any. */
export type ThreadPlace = { threadTs: SlackTs; requestId: number | null };

/** Why a thread no longer takes the reply or post queued in it. */
export type ThreadProblem =
  | "request_no_longer_valid"
  | "requester_not_allowed"
  | "thread_retracted";

/**
 * Where a post that names `thread` goes in `link`, or what to tell the lead when it can't go there
 * now. A request still waiting in that thread gets its reply first, so a post can't stand in for it.
 */
export async function findThreadPlace(
  sql: Bun.SQL,
  link: ChannelLink,
  thread: PostThread,
): Promise<ThreadPlace | { refused: string }> {
  const place =
    "request" in thread
      ? await requestThread(sql, link, thread.request)
      : await postThread(sql, link.id, thread.post);
  if ("refused" in place) return place;
  const waiting = (await readRequestsInThreads(sql, link.id, [place.threadTs])).find(
    ({ state }) => state === "open" || state === "seen",
  );
  if (!waiting) return place;
  return { refused: `r${waiting.id} waits on its answer in that thread, so answer it first.` };
}

/** Why the thread `item` is queued in no longer takes it, or null when it does. */
export async function threadProblem(
  sql: Bun.SQL,
  link: ChannelLink,
  item: OutboxItem,
): Promise<ThreadProblem | null> {
  if (item.threadTs === null) return null;
  if (item.requestId === null) {
    const [parent] = await sql`
      SELECT 1 FROM outbox WHERE link_id = ${item.linkId} AND thread_ts IS NULL
        AND slack_ts = ${item.threadTs} AND state = 'sent'
    `;
    return parent ? null : "thread_retracted";
  }
  const request = await readRequest(sql, item.requestId);
  if (
    !request ||
    request.linkId !== item.linkId ||
    request.channelId !== item.channelId ||
    request.rootTs !== item.threadTs
  )
    return "request_no_longer_valid";
  // A reply holds its request answering until it settles, so any other state means it's moved on.
  if (item.kind === "reply" && request.state !== "answering") return "request_no_longer_valid";
  return requestProblem(sql, link, request);
}

/**
 * How a post would name each of `link`'s threads that start at `rootTs` and would take one now: by
 * the link's own post the thread is under, or else by its newest request that would.
 */
export async function findPostThreads(
  sql: Bun.SQL,
  link: ChannelLink,
  rootTs: readonly SlackTs[],
): Promise<Map<SlackTs, PostThread>> {
  const threads = new Map<SlackTs, PostThread>();
  if (rootTs.length === 0) return threads;
  const posts = await sql<{ number: number; slackTs: SlackTs }[]>`
    SELECT number, slack_ts AS slackTs FROM outbox WHERE link_id = ${link.id}
      AND thread_ts IS NULL AND state = 'sent' AND slack_ts IN ${sql([...rootTs])}
  `;
  const requests = await readRequestsInThreads(sql, link.id, rootTs);
  const candidates: [SlackTs, PostThread][] = [
    ...posts.map(({ number, slackTs }): [SlackTs, PostThread] => [slackTs, { post: number }]),
    ...requests.map(({ id, rootTs }): [SlackTs, PostThread] => [rootTs, { request: id }]),
  ];
  for (const [root, thread] of candidates) {
    if (!threads.has(root) && !("refused" in (await findThreadPlace(sql, link, thread))))
      threads.set(root, thread);
  }
  return threads;
}

async function requestThread(
  sql: Bun.SQL,
  link: ChannelLink,
  id: number,
): Promise<ThreadPlace | { refused: string }> {
  const request = await readRequest(sql, id);
  if (!request || request.linkId !== link.id)
    return { refused: `This channel has no request r${id}.` };
  switch (await requestProblem(sql, link, request)) {
    case "requester_not_allowed":
      return { refused: `r${id}'s requester is no longer allowed, so its thread takes no posts.` };
    case "request_no_longer_valid":
      return { refused: `r${id} was cancelled, so its thread takes no posts.` };
    default:
      return { threadTs: request.rootTs, requestId: id };
  }
}

async function postThread(
  sql: Bun.SQL,
  linkId: string,
  number: number,
): Promise<ThreadPlace | { refused: string }> {
  // A post in a thread is named by the request it's in, or else by the link's post it's under.
  const [post] = await sql<
    {
      state: OutboxState;
      slackTs: SlackTs | null;
      threadTs: SlackTs | null;
      requestId: number | null;
      parent: number | null;
    }[]
  >`
    SELECT post.state, post.slack_ts AS slackTs, post.thread_ts AS threadTs,
      post.request_id AS requestId, parent.number AS parent
    FROM outbox post LEFT JOIN outbox parent ON parent.link_id = post.link_id
      AND parent.thread_ts IS NULL AND parent.slack_ts = post.thread_ts
    WHERE post.number = ${number} AND post.link_id = ${linkId}
  `;
  if (!post) return { refused: `This channel has no post o${number}.` };
  if (post.threadTs !== null) {
    const thread = post.requestId === null ? `o${post.parent}` : `r${post.requestId}`;
    return {
      refused: `o${number} is in ${thread}'s thread, so post there with \`--thread ${thread}\`.`,
    };
  }
  if (post.state === "queued" || post.state === "sending")
    return { refused: `o${number} isn't in Slack yet, so try again shortly.` };
  if (post.state !== "sent")
    return { refused: `o${number} has no thread to post in (${post.state}).` };
  return { threadTs: post.slackTs!, requestId: null };
}

async function requestProblem(
  sql: Bun.SQL,
  link: ChannelLink,
  request: StoredRequest,
): Promise<ThreadProblem | null> {
  if (request.state === "cancelled") return "request_no_longer_valid";
  if (!link.allowlist.has(await canonicalUserId(sql, request.requesterUserId)))
    return "requester_not_allowed";
  return null;
}

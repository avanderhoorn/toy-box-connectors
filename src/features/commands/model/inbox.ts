// What inbox shows the lead.
//
// Inbox shows each request waiting on the lead with its thread so far. Pending requests come first,
// the one that changed longest ago first, then the requests the lead has read but not answered.
// What people wrote is fenced, and each fence is labeled with who wrote it and whether they're on
// the allowlist, so the lead can tell a request from text it shouldn't act on.

import type { RequestAttention, RequestState } from "@requests/model/lifecycle";
import { isPending } from "@wakes/model";
import { fenceFor } from "./slackText";
import { ago, count } from "./wording";

/** Who wrote a message, as the bridge stored it. */
export type AuthorRole = "owner" | "allowed" | "observed" | "self" | "other";

/** Someone in Slack, by the name the bridge stored, already made safe to print beside a label. */
export type SlackPerson<UserId = string> = { userId: UserId; name: string };

export type InboxMessage = {
  ts: string;
  author: SlackPerson<string | null>;
  role: AuthorRole;
  edited: boolean;
  /** Rendered from Slack's markup. */
  text: string;
};

export type InboxRequest = {
  id: number;
  requester: SlackPerson;
  state: RequestState;
  attention: RequestAttention | null;
  createdAt: number;
  touchedAt: number | null;
  permalink: string | null;
  messages: InboxMessage[];
};

export type Inbox = {
  /** The Slack channel, as #name. */
  channel: string;
  linkStatus: "active" | "paused" | "suspended";
  requests: InboxRequest[];
  /** How many more wait than the limit showed. */
  more: number;
};

type Waiting = {
  id: number;
  state: RequestState;
  attention: RequestAttention | null;
  changedAt: number;
};

/** The requests inbox shows, pending first by when they changed, then the rest by number. */
export function inboxOrder<Request extends Waiting>(requests: readonly Request[]): Request[] {
  return requests
    .filter(({ state }) => state === "open" || state === "seen")
    .toSorted(
      (a, b) =>
        Number(isPending(b)) - Number(isPending(a)) ||
        (isPending(a) ? a.changedAt - b.changedAt : 0) ||
        a.id - b.id,
    );
}

/** The inbox as Markdown, ending with what the lead can do. */
export function presentInbox({ channel, linkStatus, requests, more }: Inbox, at: number): string {
  const sections: string[] = [];
  if (linkStatus !== "active") {
    sections.push(
      `The link is ${linkStatus}, so nothing new reaches you and nothing posts in Slack. Run \`toy-box-slack status\` to see why.`,
    );
  }
  const waiting = requests.length + more;
  if (waiting === 0) return [...sections, `Nothing in ${channel} waits on you.`].join("\n\n");
  sections.push(
    `${count(waiting, "request")} in ${channel} ${waiting === 1 ? "waits" : "wait"} on you.`,
  );
  sections.push(...requests.map((request) => presentRequest(request, at)));
  if (more > 0) {
    sections.push(`${count(more, "more request")} ${more === 1 ? "waits" : "wait"} after these.`);
  }
  sections.push(
    `End a request that needs no answer with \`toy-box-slack dismiss r${requests[0]!.id} --reason "<why>"\`.`,
  );
  return sections.join("\n\n");
}

function presentRequest(request: InboxRequest, at: number): string {
  const heading = [
    `### r${request.id}`,
    `${request.requester.name} asked ${ago(at - request.createdAt)}`,
    progress(request, at),
  ].join(" · ");
  const messages = request.messages.map(presentMessage);
  return [request.permalink ? `${heading}\n${request.permalink}` : heading, ...messages].join(
    "\n\n",
  );
}

function progress({ state, attention, touchedAt }: InboxRequest, at: number): string {
  if (attention === "updated") return "changed since you read it";
  if (attention === "reply_failed") return "your reply didn't post, so answer again";
  if (state === "open" || touchedAt === null) return "new";
  return `you read it ${ago(at - touchedAt)}`;
}

const roleLabels: Record<AuthorRole, string | null> = {
  owner: "owner",
  allowed: null,
  observed: "not on the allowlist",
  other: "not on the allowlist",
  self: "you",
};

function presentMessage({ author, role, edited, text }: InboxMessage): string {
  if (text.trim() === "") return `A message from ${author.name} has no text.`;
  const labels = [roleLabels[role], edited ? "edited" : null].filter((label) => label !== null);
  const fence = fenceFor(text);
  return `${fence}slack from ${author.name}${labels.length ? ` (${labels.join(", ")})` : ""}\n${text}\n${fence}`;
}

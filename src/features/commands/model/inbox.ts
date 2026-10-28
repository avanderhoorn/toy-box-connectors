// What people wrote is fenced, and each fence is labeled with who wrote it and whether they're on
// the allowlist, so the lead can tell a request from text it shouldn't act on.

import type { AuthorRole } from "@activity/model/ledger";
import type { RequestAttention, RequestState } from "@requests/model/lifecycle";
import { isPending } from "@wakes/model";
import { fenceFor } from "./slackText";
import { ago, count } from "./wording";

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

type Waiting = Pick<InboxRequest, "id" | "state" | "attention"> & { changedAt: number };

/** The requests inbox shows, pending first by when they changed, then the rest as given. */
export function inboxOrder<Request extends Waiting>(requests: readonly Request[]): Request[] {
  const shown = requests.filter(({ state }) => state === "open" || state === "seen");
  const pending = shown
    .filter(isPending)
    .toSorted((a, b) => a.changedAt - b.changedAt || a.id - b.id);
  return [...pending, ...shown.filter((request) => !isPending(request))];
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
  sections.push(`${count(waiting, "request")} in ${channel} ${waits(waiting)} on you.`);
  sections.push(...requests.map((request) => presentRequest(request, at)));
  if (more > 0) sections.push(`${count(more, "more request")} ${waits(more)} after these.`);
  sections.push(
    `End a request that needs no answer with \`toy-box-slack dismiss r${requests[0]!.id} --reason "<why>"\`.`,
  );
  return sections.join("\n\n");
}

function waits(n: number): string {
  return n === 1 ? "waits" : "wait";
}

function presentRequest(request: InboxRequest, at: number): string {
  const asked = `${request.requester.name} asked ${ago(at - request.createdAt)}`;
  const heading = [`### r${request.id}`, asked, progress(request, at)].join(" · ");
  const link = request.permalink ? `\n${request.permalink}` : "";
  return [`${heading}${link}`, ...request.messages.map(presentMessage)].join("\n\n");
}

function progress({ state, attention, touchedAt }: InboxRequest, at: number): string {
  if (attention === "updated") return "changed since you read it";
  if (attention === "reply_failed") return "your reply didn't post, so answer again";
  if (state === "open" || touchedAt === null) return "new";
  return `you read it ${ago(at - touchedAt)}`;
}

const roleLabels: Record<AuthorRole, string | null> = {
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

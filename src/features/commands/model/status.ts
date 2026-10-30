// Status is where the lead or the owner looks when Slack goes quiet, so everything wrong it shows
// comes with what to do about it. A bridge that hosts several apps shows each one's under its name,
// and one that hosts only the default app shows it as it did before the bridge hosted several.

import { suspensions, type SuspendReason } from "@links/model/status";
import { missingTokensProblem } from "@slackapi/model/identity";
import { STALL_AFTER, type WakeDecision, type WakeRun } from "@wakes/model";
import type { SlackPerson } from "./inbox";
import { ago, clockTime, count, duration } from "./wording";

const connections = {
  connected: "Connected.",
  connecting: "Connecting.",
  reconnecting: "Reconnecting after the connection dropped.",
  unconfigured: "Not set up.",
  auth_failed: "Slack rejects the bridge's tokens.",
  refused: "Off.",
};

export type SlackConnection = keyof typeof connections;

/** The Slack connection, and what to do about it when something's wrong. */
export type SlackState = { connection: SlackConnection; problem: string | null };

/** Slack's state while one of `app`'s tokens is missing, naming each one, or null once both are set. */
export function unconfiguredSlack({ botToken, appToken }: Tokens, app: string): SlackState | null {
  const missing = [
    botToken ? null : "SLACK_BOT_TOKEN",
    appToken ? null : "SLACK_APP_TOKEN",
  ] as const;
  const tokens = missing.filter((token) => token !== null);
  if (tokens.length === 0) return null;
  return { connection: "unconfigured", problem: missingTokensProblem(tokens, app) };
}

type Tokens = { botToken: string | null; appToken: string | null };

export type LinkStatus = {
  toyBoxChannelId: string;
  /** The Toy Box channel, as its name in quotes, or by its ID when Toy Box didn't say. */
  toyBoxChannel: string;
  slackChannelId: string;
  /** The Slack channel, as #name, or as #ID when Slack didn't say. */
  slackChannel: string;
  status: "active" | "paused" | "suspended";
  statusReason: string | null;
  requestMode: "mention" | "all";
  observe: "requesters" | "channel";
  /** Whom the link answers, in the order they were allowed. */
  allowlist: SlackPerson[];
  pending: number;
  /** Requests the lead has read but not answered. */
  read: number;
  unconfirmed: UnconfirmedPost[];
  wake: WakeDecision;
  /** Toy Box's answer to the latest wake, or null before the first. */
  lastWake: WakeRun | null;
};

/**
 * A post Slack never confirmed: an answer to a request, a series' post for a scheduled run, or a
 * post the owner or a routine asked for.
 */
export type UnconfirmedPost = {
  post: number;
  kind: "reply" | "publication" | "post";
  /** When the bridge tried to post it. */
  since: number;
  /** The request it answers, or whose thread it went in. */
  request: number | null;
  /** The lead's post whose thread a post went in, when no request names that thread. */
  parent: number | null;
  /**
   * The Slack link to its request or thread, or null for a post at the top of the channel or when
   * Slack hasn't said the workspace's URL.
   */
  permalink: string | null;
  series: string | null;
  scheduledAt: number | null;
};

export type Status = { slack: SlackState; links: LinkStatus[] };

/** One app's status, in a bridge that hosts several. */
export type AppStatus = Status & { app: string };

const halted = "so nothing new opens and nothing posts.";
const resume = "Have the owner run `toy-box-slack resume`.";

const unwoken: Record<Exclude<WakeRun["outcome"], "ran">, string> = {
  missing:
    "No routine in this Toy Box channel runs `toy-box-slack inbox`, or the channel was deleted. Create that routine, or run `toy-box-slack unlink` if the channel is gone. Last checked",
  failed: "Toy Box didn't answer the last wake, so the bridge retries. It last tried",
  refused: "Toy Box refused the last wake",
};

/** Status as Markdown, a section for Slack and one for each link. */
export function presentStatus(status: Status, at: number): string {
  return presentSections(status, at, "No Toy Box channel is linked to Slack yet.");
}

/** Several apps' status as Markdown, each app's sections under its name. */
export function presentAppStatuses(apps: readonly AppStatus[], at: number): string {
  return apps
    .map(({ app, ...status }) => {
      const unlinked = `No Toy Box channel links through the ${app} app yet.`;
      return `# The ${app} app\n\n${presentSections(status, at, unlinked)}`;
    })
    .join("\n\n");
}

function presentSections({ slack, links }: Status, at: number, unlinked: string): string {
  const connection = [connections[slack.connection], slack.problem].filter(Boolean).join(" ");
  const sections = [`## Slack\n${connection}`, ...links.map((link) => presentLink(link, at))];
  if (links.length === 0) sections.push(unlinked);
  return sections.join("\n\n");
}

function presentLink(link: LinkStatus, at: number): string {
  const asks = link.requestMode === "all" ? "post or mention the bot" : "mention the bot";
  const people = new Intl.ListFormat("en").format(
    link.allowlist.map(({ name, userId }) => `${name} (${userId})`),
  );
  const answers = people ? `${people} when they ${asks}` : "nobody yet";
  const threads = link.observe === "channel" ? "everyone" : "only the people it answers";
  return [
    `## ${link.slackChannel} and Toy Box channel ${link.toyBoxChannel}`,
    `- Link: ${presentLinkState(link)}`,
    `- Answers: ${answers}. Threads show ${threads}.`,
    `- Requests: ${link.pending} new or changed, ${link.read} read and not answered.`,
    ...presentUnconfirmed(link.unconfirmed, at),
    `- Wakes: ${presentWake(link, at)}`,
  ].join("\n");
}

function presentUnconfirmed(posts: UnconfirmedPost[], at: number): string[] {
  if (posts.length === 0) return [];
  return [
    "- Posts: Slack never confirmed these landed, and the bridge won't send them again. Have the owner check each one. Anyone whose answer is missing can ask again in its thread.",
    ...posts.map(({ post, since, permalink, ...item }) => {
      const what = describeUnconfirmed(item);
      return `  - o${post}, ${what}, tried ${ago(at - since)}${permalink ? `: ${permalink}` : "."}`;
    }),
  ];
}

function describeUnconfirmed({
  kind,
  request,
  parent,
  series,
  scheduledAt,
}: Omit<UnconfirmedPost, "post" | "since" | "permalink">): string {
  if (kind === "publication")
    return `the ${series} post for the run scheduled ${clockTime(scheduledAt!)}`;
  if (kind === "reply") return `the answer to r${request}`;
  if (request !== null) return `a post in r${request}'s thread`;
  return parent === null ? "a post at the top of the channel" : `a post in o${parent}'s thread`;
}

/** A link's state as it reads after "is", and what ends it when it isn't active. */
export function presentLinkState({
  status,
  statusReason,
}: Pick<LinkStatus, "status" | "statusReason">): string {
  if (status === "active") return "active.";
  const suspension = status === "suspended" ? suspensions[statusReason as SuspendReason] : null;
  if (!suspension) return `${status}, ${halted} ${resume}`;
  return `suspended ${suspension.because}, ${halted} ${suspension.fix}`;
}

function presentWake({ wake, lastWake }: LinkStatus, at: number): string {
  const last =
    lastWake && lastWake.outcome !== "ran"
      ? ` ${unwoken[lastWake.outcome]} ${ago(at - lastWake.at)}.`
      : "";
  switch (wake.kind) {
    case "wake":
      return `waking the lead now.${last}`;
    case "wait":
      return `next wake in ${duration(wake.until - at)}.${last}`;
    case "idle":
      return `nothing waits for the lead.${last}`;
    case "stalled":
      return `stalled, since the lead was woken ${count(STALL_AFTER, "time")} without running \`toy-box-slack inbox\`. Wakes wait for something new in Slack.${last}`;
    case "blocked":
      return "blocked until a new request, because Toy Box refused the last wake. The bridge's log says why.";
  }
}

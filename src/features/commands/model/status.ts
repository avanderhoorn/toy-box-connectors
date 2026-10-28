// What status shows.
//
// Status is where the lead or the owner looks when Slack goes quiet. It says whether Slack is
// connected and, for each link in view, its settings, who it answers, the requests waiting and what
// the bridge last decided about waking the lead, each with what to do about anything that's wrong.

import { suspensions, type SuspendReason } from "@links/model/status";
import { STALL_AFTER, type WakeDecision, type WakeRun } from "@wakes/model";
import { ago, count, duration, joinNames } from "./wording";

export type SlackConnection =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "unconfigured"
  | "auth_failed"
  | "refused";

/** The Slack connection, and what to do about it when something's wrong. */
export type SlackState = { connection: SlackConnection; problem: string | null };

/** Slack's state while a token is missing, naming each one, or null once both are set. */
export function unconfiguredSlack(tokens: {
  botToken: string | null;
  appToken: string | null;
}): SlackState | null {
  const missing = [
    ...(tokens.botToken ? [] : ["SLACK_BOT_TOKEN"]),
    ...(tokens.appToken ? [] : ["SLACK_APP_TOKEN"]),
  ];
  if (missing.length === 0) return null;
  const [verb, pronoun] = missing.length === 1 ? ["isn't", "it"] : ["aren't", "them"];
  return {
    connection: "unconfigured",
    problem: `${missing.join(" and ")} ${verb} set. Add ${pronoun} to credentials.env in the bridge's data folder, then restart the bridge.`,
  };
}

export type LinkStatus = {
  toyBoxChannelId: string;
  /** The Slack channel, as #name. */
  slackChannel: string;
  status: "active" | "paused" | "suspended";
  statusReason: string | null;
  requestMode: "mention" | "all";
  observe: "requesters" | "channel";
  /** The names of the people the link answers. */
  allowlist: string[];
  pending: number;
  /** Requests the lead has read but not answered. */
  read: number;
  wake: WakeDecision;
  /** Toy Box's answer to the latest wake, or null before the first. */
  lastWake: WakeRun | null;
};

export type Status = { slack: SlackState; links: LinkStatus[] };

/** Status as Markdown, a section for Slack and one for each link. */
export function presentStatus({ slack, links }: Status, at: number): string {
  const sections = [
    `## Slack\n${[connections[slack.connection], slack.problem].filter(Boolean).join(" ")}`,
  ];
  if (links.length === 0) sections.push("No Toy Box channel is linked to Slack yet.");
  for (const link of links) sections.push(presentLink(link, at));
  return sections.join("\n\n");
}

const connections: Record<SlackConnection, string> = {
  connected: "Connected.",
  connecting: "Connecting.",
  reconnecting: "Reconnecting after the connection dropped.",
  unconfigured: "Not set up.",
  auth_failed: "Slack rejects the bridge's tokens.",
  refused: "Off.",
};

function presentLink(link: LinkStatus, at: number): string {
  const asks = link.requestMode === "all" ? "posts or mentions the bot" : "mentions the bot";
  const people = link.allowlist.length === 0 ? "nobody yet" : joinNames(link.allowlist);
  return [
    `## ${link.slackChannel} and Toy Box channel ${link.toyBoxChannelId}`,
    `- Link: ${presentLinkState(link)}`,
    `- Answers: ${people}, when one ${asks}. Threads show ${link.observe === "channel" ? "everyone" : "only the people it answers"}.`,
    `- Requests: ${link.pending} new or changed, ${link.read} read and not answered.`,
    `- Wakes: ${presentWake(link, at)}`,
  ].join("\n");
}

function presentLinkState({ status, statusReason }: LinkStatus): string {
  if (status === "active") return "active.";
  if (status === "paused") {
    return "paused, so nothing new opens and nothing posts. Have the owner run `toy-box-slack resume`.";
  }
  const suspension = suspensions[statusReason as SuspendReason];
  return suspension
    ? `suspended ${suspension.because}, so nothing new opens and nothing posts. ${suspension.fix}`
    : "suspended, so nothing new opens and nothing posts. Have the owner run `toy-box-slack resume`.";
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
      return `blocked until a new request, because Toy Box refused the last wake. The bridge's log says why.`;
  }
}

const unwoken: Record<Exclude<WakeRun["outcome"], "ran">, string> = {
  missing:
    "No routine in this Toy Box channel runs `toy-box-slack inbox`, or the channel was deleted. Create that routine, or run `toy-box-slack unlink` if the channel is gone. Last checked",
  failed: "Toy Box didn't answer the last wake, so the bridge retries. It last tried",
  refused: "Toy Box refused the last wake",
};

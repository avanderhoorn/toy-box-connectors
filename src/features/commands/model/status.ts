// Status is where the lead or the owner looks when Slack goes quiet, so everything wrong it shows
// comes with what to do about it.

import { suspensions, type SuspendReason } from "@links/model/status";
import { STALL_AFTER, type WakeDecision, type WakeRun } from "@wakes/model";
import { ago, count, duration } from "./wording";

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

/** Slack's state while a token is missing, naming each one, or null once both are set. */
export function unconfiguredSlack({ botToken, appToken }: Tokens): SlackState | null {
  const missing = [botToken ? "" : "SLACK_BOT_TOKEN", appToken ? "" : "SLACK_APP_TOKEN"];
  const named = missing.filter(Boolean).join(" and ");
  if (!named) return null;
  const problem = `Put ${named} in credentials.env in the bridge's data folder, then restart the bridge.`;
  return { connection: "unconfigured", problem };
}

type Tokens = { botToken: string | null; appToken: string | null };

export type LinkStatus = {
  toyBoxChannelId: string;
  /** The Slack channel, as #name. */
  slackChannel: string;
  status: "active" | "paused" | "suspended";
  statusReason: string | null;
  requestMode: "mention" | "all";
  observe: "requesters" | "channel";
  allowlist: string[];
  pending: number;
  /** Requests the lead has read but not answered. */
  read: number;
  wake: WakeDecision;
  /** Toy Box's answer to the latest wake, or null before the first. */
  lastWake: WakeRun | null;
};

export type Status = { slack: SlackState; links: LinkStatus[] };

const halted = "so nothing new opens and nothing posts.";
const resume = "Have the owner run `toy-box-slack resume`.";

const unwoken: Record<Exclude<WakeRun["outcome"], "ran">, string> = {
  missing:
    "No routine in this Toy Box channel runs `toy-box-slack inbox`, or the channel was deleted. Create that routine, or run `toy-box-slack unlink` if the channel is gone. Last checked",
  failed: "Toy Box didn't answer the last wake, so the bridge retries. It last tried",
  refused: "Toy Box refused the last wake",
};

/** Status as Markdown, a section for Slack and one for each link. */
export function presentStatus({ slack, links }: Status, at: number): string {
  const connection = [connections[slack.connection], slack.problem].filter(Boolean).join(" ");
  const sections = [`## Slack\n${connection}`, ...links.map((link) => presentLink(link, at))];
  if (links.length === 0) sections.push("No Toy Box channel is linked to Slack yet.");
  return sections.join("\n\n");
}

function presentLink(link: LinkStatus, at: number): string {
  const asks = link.requestMode === "all" ? "posts or mentions the bot" : "mentions the bot";
  const people = new Intl.ListFormat("en").format(link.allowlist) || "nobody yet";
  const threads = link.observe === "channel" ? "everyone" : "only the people it answers";
  return [
    `## ${link.slackChannel} and Toy Box channel ${link.toyBoxChannelId}`,
    `- Link: ${presentLinkState(link)}`,
    `- Answers: ${people}, when one ${asks}. Threads show ${threads}.`,
    `- Requests: ${link.pending} new or changed, ${link.read} read and not answered.`,
    `- Wakes: ${presentWake(link, at)}`,
  ].join("\n");
}

function presentLinkState({ status, statusReason }: LinkStatus): string {
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

// The status command.
//
// Status is where every banner points. It says whether Slack is connected and, for each link in
// view, whether the bridge follows its Toy Box channel, has every message, can wake its lead and
// still has the routines it runs, each with what to do about anything that's wrong. The lead and
// members see their own channel's link, and the operator sees every link unless it names one.

import { z } from "zod";
import { publishCommand, REQUESTS_COMMAND } from "@toybox/model";
import { RELEASE_NOTES_SERIES } from "@toybox/model/routines";
import { coverageSchema, describeSuspension, slackConnectionSchema } from "./banner";
import { commandContract, type PresentContext } from "./contract";

const wakeBlockSchema = z.enum(["link_inactive", "routine_missing", "provider", "refused"]);

const wakeSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("wake"),
        reason: z.enum(["requests", "reminder", "setup", "catch_up"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("wait"),
        until: z.union([z.number().int(), z.enum(["lead_idle", "toy_box", "slack"])]),
      })
      .strict(),
    z.object({ kind: z.literal("idle") }).strict(),
    z.object({ kind: z.literal("blocked"), reason: wakeBlockSchema }).strict(),
    z.object({ kind: z.literal("stalled") }).strict(),
  ])
  .describe("What the bridge last decided about waking the lead");

const routineStatusSchema = z
  .object({
    series: z
      .string()
      .nullable()
      .describe("The publication series it posts, or null for the requests routine"),
    routineId: z.string(),
    period: z
      .enum(["day", "week"])
      .nullable()
      .describe("How often the series publishes, or null for the requests routine"),
    state: z
      .enum(["present", "drifted", "missing"])
      .describe(
        "present; drifted once its prompt no longer runs its command; missing once deleted",
      ),
  })
  .strict();

const linkStatusSchema = z
  .object({
    id: z.string(),
    toyBoxChannelId: z.string(),
    slackChannelId: z.string(),
    status: z.enum(["active", "paused", "suspended"]),
    statusReason: z.string().nullable().describe("Why the bridge suspended the link"),
    coverage: coverageSchema,
    following: z.boolean().describe("Whether the bridge is connected to the channel's stream"),
    wake: wakeSchema.nullable().describe("Null until the bridge first decides"),
    routines: z.array(routineStatusSchema).describe("The requests routine first"),
  })
  .strict();
export type LinkStatus = z.output<typeof linkStatusSchema>;

/** The Slack connection, and what to do about it when something's wrong. */
export const slackStateSchema = z
  .object({
    connection: slackConnectionSchema,
    problem: z.string().nullable().describe("What's wrong with Slack and how to fix it"),
  })
  .strict();
export type SlackState = z.output<typeof slackStateSchema>;

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

export const statusResultSchema = z
  .object({
    slack: slackStateSchema,
    toyBox: z.string().describe("The origin of the Toy Box the bridge serves"),
    channelId: z.string().nullable().describe("The Toy Box channel in view, or null for all"),
    links: z.array(linkStatusSchema),
  })
  .strict();
export type StatusResult = z.output<typeof statusResultSchema>;

export const statusContract = commandContract({
  description: "Show Slack's connection and the health of each link",
  roles: ["lead", "member", "operator"],
  scope: "bridge",
  withoutSlack: true,
  input: z.object({}).strict(),
  result: statusResultSchema,
  present: presentStatus,
});

/** Status as Markdown, a section for Slack and one for each link. */
export function presentStatus(status: StatusResult, { at }: PresentContext): string {
  const sections = [presentSlack(status.slack), `Toy Box: ${status.toyBox}`];
  if (status.links.length === 0) {
    sections.push(
      status.channelId === null
        ? "No Toy Box channel is linked to Slack yet."
        : `Toy Box channel ${status.channelId} isn't linked to Slack. Run \`toy-box-slack link --slack-channel <id> --routine <id>\` to link it.`,
    );
  }
  for (const link of status.links) sections.push(presentLink(link, at));
  return sections.join("\n\n");
}

function presentSlack({ connection, problem }: SlackState): string {
  return `## Slack\n${[slackStates[connection], problem].filter(Boolean).join(" ")}`;
}

const slackStates: Record<SlackState["connection"], string> = {
  connected: "Connected.",
  connecting: "Connecting.",
  reconnecting: "Reconnecting after the connection dropped.",
  unconfigured: "Not set up.",
  auth_failed: "Slack rejects the bridge's tokens.",
  refused: "Off.",
};

function presentLink(link: LinkStatus, at: number): string {
  return [
    `## Toy Box channel ${link.toyBoxChannelId} and Slack channel ${link.slackChannelId}`,
    `- Link: ${presentLinkState(link)}`,
    `- Coverage: ${coveragePhrases[link.coverage]}`,
    `- Toy Box: ${link.following ? "following the channel" : "not following the channel's stream yet, retrying"}`,
    `- Wakes: ${link.wake === null ? "not decided yet" : presentWake(link.wake, at)}`,
    ...link.routines.map((routine) => `- ${presentRoutine(routine)}`),
  ].join("\n");
}

function presentLinkState({ status, statusReason }: LinkStatus): string {
  switch (status) {
    case "active":
      return "active.";
    case "paused":
      return "paused, so nothing new opens and posts wait. Run `toy-box-slack resume` to ask the owner to resume it.";
    case "suspended": {
      const { because, fix } = describeSuspension(statusReason);
      return `suspended ${because}, so nothing new opens and posts wait. ${fix}`;
    }
  }
}

const coveragePhrases: Record<LinkStatus["coverage"], string> = {
  complete: "complete.",
  repairing: "repairing, reading back what the bridge may have missed.",
  partial: "partial, a repair couldn't finish, so some messages may be missing.",
};

function presentWake(wake: NonNullable<LinkStatus["wake"]>, at: number): string {
  switch (wake.kind) {
    case "wake":
      return "waking the lead now.";
    case "wait":
      if (wake.until === "lead_idle") return "waiting for the lead's turn to end.";
      if (wake.until === "toy_box") return "waiting for the channel's Toy Box stream.";
      if (wake.until === "slack") return "waiting until the bridge can use Slack.";
      return `next wake in about ${Math.max(Math.ceil((wake.until - at) / 60_000), 1)} min.`;
    case "idle":
      return "nothing is waiting for the lead.";
    case "stalled":
      return "stalled. The lead was woken several times without running `toy-box-slack inbox`, so the bridge won't wake it again until a request changes.";
    case "blocked":
      return wakeBlocks[wake.reason];
  }
}

const wakeBlocks: Record<z.output<typeof wakeBlockSchema>, string> = {
  link_inactive: "off while the link isn't active.",
  routine_missing:
    "blocked, because the requests routine is gone. Register a new one from `toy-box-slack routines --template requests`.",
  provider:
    "blocked for good, because the channel's lead doesn't run on Copilot. Create a Copilot channel and link that instead.",
  refused:
    "blocked, because Toy Box refused to run the requests routine. Register a new one from `toy-box-slack routines --template requests`.",
};

function presentRoutine({ series, routineId, period, state }: LinkStatus["routines"][number]) {
  const name = series === null ? "Requests routine" : `Routine for ${series}`;
  const command = series === null ? REQUESTS_COMMAND : publishCommand(series);
  const register = registerStep(series, period);
  switch (state) {
    case "present":
      return `${name}: ${routineId}.`;
    case "drifted":
      return `${name}: ${routineId} no longer runs \`${command}\`. Put that back in its prompt in Toy Box, or register another ${register}.`;
    case "missing":
      return `${name}: ${routineId} was deleted. Register a new one ${register}.`;
  }
}

// A routine from a template is registered again from it, since the template says how to give the
// bridge its ID.
function registerStep(series: string | null, period: "day" | "week" | null): string {
  if (series === null) return "from `toy-box-slack routines --template requests`";
  if (series === RELEASE_NOTES_SERIES)
    return "from `toy-box-slack routines --template release-notes`";
  return `with \`toy-box-slack routine --publish <id> --series ${series} --period ${period ?? "day"}\``;
}

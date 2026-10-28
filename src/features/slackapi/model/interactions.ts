import { z } from "zod";
import { issuesOf } from "./envelopes";
import { slackTsSchema, type SlackTs } from "./ts";

// Interactive payloads.
//
// An interactive envelope carries what someone did with something the app showed them. The bridge
// only shows buttons, on approval cards, so it reads block_actions and passes any other type on by
// name. The payload's team is the workspace the app is installed in, not the clicker's, and Slack
// leaves it null when the app is installed org-wide, which v1 refuses at startup. Who clicked is
// named by an ID that can be their org-wide one.
// https://docs.slack.dev/reference/interaction-payloads/block_actions-payload

const slackIdSchema = z.string().min(1);

/** A click on a button, and the message it was on. */
export type BlockActions = {
  appId: string;
  /** The workspace the app is installed in, or null when it's installed org-wide. */
  teamId: string | null;
  /** Who clicked, as Slack names them, which can be their org-wide ID. */
  userId: string;
  /** What was clicked. A button carries the value the app gave it, if any. */
  actions: { actionId: string; value: string | null }[];
  /** The message the click was on, or null when it was on an ephemeral message or another surface. */
  message: { channelId: string; ts: SlackTs } | null;
};

/** One interactive payload, as much of it as the bridge reads. */
export type Interaction =
  | { kind: "block_actions"; click: BlockActions }
  /** A type the app never asks for, such as a shortcut or a view submission. */
  | { kind: "other"; type: string }
  /** `issues` names zod issue codes and paths only, never content, so it's safe to log. */
  | { kind: "malformed"; issues: string[] };

const interactionHeaderSchema = z.object({
  type: z.string().min(1).describe("The kind of interaction, such as block_actions"),
});

const blockActionsSchema = z
  .object({
    api_app_id: slackIdSchema.describe("The app the interaction is for"),
    team: z
      .object({ id: slackIdSchema.describe("The workspace's ID") })
      .nullish()
      .describe("The workspace the app is installed in, null when it's installed org-wide"),
    user: z
      .object({ id: slackIdSchema.describe("The user's ID, which can be their org-wide one") })
      .describe("Who clicked"),
    container: z
      .object({
        type: z.string().describe("message for a message, or the surface's type"),
        channel_id: slackIdSchema.nullish().describe("The message's channel"),
        message_ts: slackTsSchema.nullish().describe("The message's ts"),
        is_ephemeral: z.boolean().nullish().describe("Whether only the clicker could see it"),
      })
      .describe("Where the click happened"),
    actions: z
      .array(
        z
          .object({
            action_id: z.string().describe("The ID the app gave the element"),
            value: z.string().nullish().describe("The value the app gave the button"),
          })
          .describe("One element that was used"),
      )
      .nullish()
      .describe("What was used, which a click on a button lists once"),
  })
  .describe("A click on an interactive element");

/** Reads an interactive envelope's payload. Never throws. */
export function readInteraction(payload: unknown): Interaction {
  const header = interactionHeaderSchema.safeParse(payload);
  if (!header.success) return { kind: "malformed", issues: issuesOf(header.error) };
  if (header.data.type !== "block_actions") return { kind: "other", type: header.data.type };
  const parsed = blockActionsSchema.safeParse(payload);
  if (!parsed.success) return { kind: "malformed", issues: issuesOf(parsed.error) };

  const { api_app_id, team, user, container, actions } = parsed.data;
  const onMessage =
    container.type === "message" &&
    container.is_ephemeral !== true &&
    container.channel_id != null &&
    container.message_ts != null;
  return {
    kind: "block_actions",
    click: {
      appId: api_app_id,
      teamId: team?.id ?? null,
      userId: user.id,
      actions: (actions ?? []).map((action) => ({
        actionId: action.action_id,
        value: action.value ?? null,
      })),
      message: onMessage ? { channelId: container.channel_id!, ts: container.message_ts! } : null,
    },
  };
}

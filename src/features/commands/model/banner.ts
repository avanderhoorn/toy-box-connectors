// The banner.
//
// Every command's output opens with one line saying whether Slack is connected, whether the bridge
// has every message of the linked channel, and what needs a person, so nobody acts on a bridge
// they believe is healthy when it isn't. For the lead, until its turn ends, the banner also hands
// back what it was waiting for before the turn, because the routine run that woke it cleared that
// status.

import { z } from "zod";
import { publishCommand, REQUESTS_COMMAND } from "@toybox/model";

/** The Slack connection as every caller sees it. */
export const slackConnectionSchema = z
  .enum(["connected", "connecting", "reconnecting", "unconfigured", "auth_failed", "refused"])
  .describe(
    "connected; connecting until Slack first says hello; reconnecting after a drop; unconfigured without both tokens; auth_failed while Slack rejects the tokens; refused while the bridge won't use them",
  );
export type SlackConnection = z.output<typeof slackConnectionSchema>;

/** Whether the bridge has every message it should. */
export const coverageSchema = z
  .enum(["complete", "repairing", "partial"])
  .describe(
    "complete; repairing while the bridge reads back what it may have missed; partial when a repair couldn't finish",
  );
export type Coverage = z.output<typeof coverageSchema>;

const seriesSchema = z
  .string()
  .nullable()
  .describe("The publication series the routine posts, or null for the link's requests routine");

const postSchema = z
  .object({
    item: z.string().describe("The outbox item, such as o31"),
    kind: z
      .enum(["reply", "progress", "publication", "retract", "card", "reaction", "status"])
      .describe("What the post was"),
  })
  .strict();
export type BannerPost = z.output<typeof postSchema>;

/** Something that needs a person, named in every banner until it's fixed. */
export const bannerWarningSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("routine_missing"), series: seriesSchema })
    .strict()
    .describe("The routine was deleted in Toy Box, and the bridge never recreates it"),
  z
    .object({ kind: z.literal("routine_drifted"), series: seriesSchema })
    .strict()
    .describe("The routine's prompt no longer runs the command the bridge runs it for"),
  z
    .object({ kind: z.literal("delivery_unknown"), posts: z.array(postSchema).min(1) })
    .strict()
    .describe("Posts that may have reached Slack, which the bridge never resends on its own"),
  z
    .object({ kind: z.literal("stray"), posts: z.array(postSchema).min(1) })
    .strict()
    .describe("Replies that landed outside their thread, which the bridge couldn't delete"),
]);
export type BannerWarning = z.output<typeof bannerWarningSchema>;

/** The finish_agent_turn arguments that restore the lead's waiting status. */
export const restoreSchema = z
  .object({
    waitingFor: z.string().describe("What the lead was waiting for before this turn"),
    wakeAfterMinutes: z
      .number()
      .int()
      .min(5)
      .max(120)
      .nullable()
      .describe("The minutes left until its old wake time, or null when it had none"),
  })
  .strict();
export type Restore = z.output<typeof restoreSchema>;

export const bannerSchema = z
  .object({
    slack: slackConnectionSchema,
    coverage: coverageSchema.nullable().describe("Null when no linked channel is in view"),
    warnings: z.array(bannerWarningSchema),
    restore: restoreSchema
      .nullable()
      .describe("Only for a lead whose turn began by clearing its waiting status"),
  })
  .strict();
export type Banner = z.output<typeof bannerSchema>;

/** The banner as a Markdown quote. */
export function presentBanner(banner: Banner): string {
  const health = [
    `Slack: ${slackPhrases[banner.slack]}`,
    ...(banner.coverage === null ? [] : [`coverage ${banner.coverage}`]),
    ...banner.warnings.map(presentWarning),
  ].join(" · ");
  const lines = [isHealthy(banner) ? health : `${health}, see \`toy-box-slack status\``];
  if (banner.restore) lines.push(presentRestore(banner.restore));
  return lines.map((line) => `> ${line}`).join("\n");
}

function isHealthy({ slack, coverage, warnings }: Banner): boolean {
  return slack === "connected" && (coverage ?? "complete") === "complete" && warnings.length === 0;
}

const slackPhrases: Record<SlackConnection, string> = {
  connected: "connected",
  connecting: "connecting",
  reconnecting: "reconnecting",
  unconfigured: "not set up",
  auth_failed: "tokens rejected",
  refused: "off",
};

function presentWarning(warning: BannerWarning): string {
  switch (warning.kind) {
    case "routine_missing":
      return warning.series === null
        ? "the requests routine is gone, register a new one with `toy-box-slack routine --requests <id>`"
        : `the ${warning.series} routine is gone`;
    case "routine_drifted":
      return warning.series === null
        ? `the requests routine no longer runs \`${REQUESTS_COMMAND}\``
        : `the ${warning.series} routine no longer runs \`${publishCommand(warning.series)}\``;
    case "delivery_unknown":
      return `${presentPosts(warning.posts)} delivery unknown (${itemList(warning.posts)})`;
    case "stray":
      return `${presentPosts(warning.posts)} outside ${warning.posts.length === 1 ? "its thread" : "their threads"} (${itemList(warning.posts)})`;
  }
}

const postNouns: Record<BannerPost["kind"], [string, string]> = {
  reply: ["reply", "replies"],
  progress: ["progress note", "progress notes"],
  publication: ["publication", "publications"],
  retract: ["retraction", "retractions"],
  card: ["approval card", "approval cards"],
  reaction: ["reaction", "reactions"],
  status: ["thread status", "thread statuses"],
};

// Posts of one kind take its noun, and a mix is just posts.
function presentPosts(posts: readonly BannerPost[]): string {
  const kinds = new Set(posts.map((post) => post.kind));
  const [one, many] = kinds.size === 1 ? postNouns[posts[0]!.kind] : ["post", "posts"];
  return `${posts.length} ${posts.length === 1 ? one : many}`;
}

function itemList(posts: readonly BannerPost[]): string {
  return posts.map((post) => post.item).join(", ");
}

// The lead's status is one line, so a newline it saved can't end the quote early.
function presentRestore({ waitingFor, wakeAfterMinutes }: Restore): string {
  const wake = wakeAfterMinutes === null ? "" : ` and wakeAfterMinutes ${wakeAfterMinutes}`;
  const text = waitingFor.replace(/\s+/g, " ").trim();
  return `Before this turn you were waiting for "${text}". If that's still true when you finish, call finish_agent_turn with that waitingFor${wake}.`;
}

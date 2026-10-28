// The banner.
//
// Every command's output opens with one line saying whether Slack is connected, whether the bridge
// has every message of the linked channel, and what needs a person, so nobody acts on a bridge
// they believe is healthy when it isn't. For the lead, until its turn ends, the banner also hands
// back what it was waiting for before the turn, because the routine run that woke it cleared that
// status.

import { z } from "zod";
import { suspensions, type SuspendReason, type Suspension } from "@links/model/status";
import { publishCommand, REQUESTS_COMMAND, type RoutineState } from "@toybox/model";

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
    .object({
      kind: z.literal("link_inactive"),
      status: z.enum(["paused", "suspended"]),
      reason: z.string().nullable().describe("Why the bridge suspended the link, as it stored it"),
    })
    .strict()
    .describe("The link opens no new requests, and its posts wait until it's active again"),
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

/** What the banner reads of one link in view. */
export type LinkHealth = {
  status: "active" | "paused" | "suspended";
  statusReason: string | null;
  coverage: Coverage;
  /** Null for the link's requests routine and the series for a publication's. */
  routines: readonly { series: string | null; state: RoutineState }[];
};

/** A post only a person can settle, because the bridge never resends or deletes it on its own. */
export type UnsettledPost = BannerPost & { state: "delivery_unknown" | "stray" };

/**
 * The banner for the links in view. A warning that reads the same for two links is named once,
 * because the operator's banner covers every link and status says which.
 */
export function composeBanner({
  slack,
  links,
  posts,
  restore,
}: {
  slack: SlackConnection;
  links: readonly LinkHealth[];
  posts: readonly UnsettledPost[];
  restore: Restore | null;
}): Banner {
  const warnings: BannerWarning[] = [];
  for (const link of links) {
    if (link.status !== "active") {
      const reason = link.status === "suspended" ? link.statusReason : null;
      warnings.push({ kind: "link_inactive", status: link.status, reason });
    }
    for (const { series, state } of link.routines) {
      if (state === "missing") warnings.push({ kind: "routine_missing", series });
      if (state === "drifted") warnings.push({ kind: "routine_drifted", series });
    }
  }
  for (const state of ["delivery_unknown", "stray"] as const) {
    const unsettled = posts.filter((post) => post.state === state);
    if (unsettled.length === 0) continue;
    warnings.push({ kind: state, posts: unsettled.map(({ item, kind }) => ({ item, kind })) });
  }
  return {
    slack,
    coverage: links.length === 0 ? null : worstCoverage(links.map((link) => link.coverage)),
    warnings: warnings.filter(
      (warning, index) =>
        warnings.findIndex((other) => JSON.stringify(other) === JSON.stringify(warning)) === index,
    ),
    restore,
  };
}

// A repair under way comes first, because whatever it finds may still change the answer.
function worstCoverage(coverages: readonly Coverage[]): Coverage {
  if (coverages.includes("repairing")) return "repairing";
  return coverages.includes("partial") ? "partial" : "complete";
}

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
    case "link_inactive":
      return warning.status === "paused"
        ? "link paused, its posts wait until it's resumed"
        : `link suspended ${describeSuspension(warning.reason).because}, its posts wait`;
    case "routine_missing":
      return warning.series === null
        ? "the requests routine is gone, register a new one from `toy-box-slack routines --template requests`"
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

/**
 * Why the bridge suspended a link and what ends it, even for a reason this version doesn't know,
 * such as one a newer bridge stored.
 */
export function describeSuspension(reason: string | null): Suspension {
  if (reason !== null && Object.hasOwn(suspensions, reason)) {
    return suspensions[reason as SuspendReason];
  }
  return {
    because: reason === null ? "for a reason it didn't record" : `(${reason})`,
    fix: "Fix what suspended it, then run `toy-box-slack resume` for the owner to approve in Slack.",
  };
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

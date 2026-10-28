import { z } from "zod";

// People as users.info describes them.
//
// The bridge keeps what admitting someone as the owner or an allowed person needs: who they are,
// what kind of account they have, and the workspace and Enterprise org Slack places them in, along
// with the names it shows them by. Slack adds fields without notice, so unknown keys are dropped. A
// flag Slack leaves out reads as unset, as it documents for deleted, while a workspace or org it
// leaves out stays unknown, so the admission check refuses rather than guesses.

/** A Slack user, as users.info described them. */
export type SlackPerson = {
  id: string;
  /** The workspace Slack places them in, or null when it didn't say. */
  teamId: string | null;
  /** The Enterprise org their enterprise_user names, or null outside one or when Slack didn't say. */
  enterpriseId: string | null;
  /** Their enterprise_user ID, which a message or click from them can carry instead of `id`. */
  enterpriseUserId: string | null;
  isBot: boolean;
  isWorkflowBot: boolean;
  /** Their account is deactivated. */
  deleted: boolean;
  /** A multi-channel guest. */
  isRestricted: boolean;
  /** A single-channel guest. */
  isUltraRestricted: boolean;
  displayName: string | null;
  realName: string | null;
};

/** A user object from users.info, read into what the bridge keeps. */
export const slackUserSchema = z
  .object({
    id: z.string().min(1).describe("The user's ID"),
    team_id: z.string().min(1).nullish().describe("The workspace Slack places them in"),
    deleted: z.boolean().nullish().describe("Their account is deactivated"),
    is_bot: z.boolean().nullish().describe("A bot user"),
    is_workflow_bot: z.boolean().nullish().describe("A bot Workflow Builder runs as"),
    is_restricted: z.boolean().nullish().describe("A multi-channel guest"),
    is_ultra_restricted: z.boolean().nullish().describe("A single-channel guest"),
    real_name: z.string().nullish().describe("Their full name"),
    profile: z
      .object({
        display_name: z.string().nullish().describe("The name they chose to show, often empty"),
        real_name: z.string().nullish().describe("Their full name"),
      })
      .nullish()
      .describe("Their profile"),
    enterprise_user: z
      .object({
        id: z.string().min(1).nullish().describe("Their ID across the Enterprise org"),
        enterprise_id: z.string().min(1).nullish().describe("The Enterprise org they belong to"),
      })
      .nullish()
      .describe("Who they are in an Enterprise org, absent outside one"),
  })
  .describe("A Slack user")
  .transform((user): SlackPerson => ({
    id: user.id,
    teamId: user.team_id ?? null,
    enterpriseId: user.enterprise_user?.enterprise_id ?? null,
    enterpriseUserId: user.enterprise_user?.id ?? null,
    isBot: user.is_bot ?? false,
    isWorkflowBot: user.is_workflow_bot ?? false,
    deleted: user.deleted ?? false,
    isRestricted: user.is_restricted ?? false,
    isUltraRestricted: user.is_ultra_restricted ?? false,
    displayName: user.profile?.display_name || null,
    realName: user.real_name || user.profile?.real_name || null,
  }));

/** The IDs a message or click from `person` can carry: their user ID, then any other ID Slack gave them. */
export function personIds(person: SlackPerson): string[] {
  const ids = [person.id];
  if (person.enterpriseUserId && person.enterpriseUserId !== person.id) {
    ids.push(person.enterpriseUserId);
  }
  return ids;
}

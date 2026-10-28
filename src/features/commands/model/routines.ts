// The routines command.
//
// Routines shows the templates the lead registers in Toy Box with set_routine, each ending with how
// to give the bridge the routine's ID. Every link needs the requests routine, since the bridge runs
// it to wake the lead, and the digest and release notes are the owner's choice. A template's step
// follows the link: before there's one, the requests routine's ID goes to link, and a routine the
// link has can be updated in place unless it was deleted.

import { z } from "zod";
import { publishCommand, REQUESTS_COMMAND } from "@toybox/model";
import {
  RELEASE_NOTES_SERIES,
  releaseNotesSchedules,
  routineTemplateNames,
  type RoutineTemplateName,
} from "@toybox/model/routines";
import { commandContract } from "./contract";
import { fenceFor } from "./slackText";

const linkRoutineSchema = z
  .object({
    routineId: z.string(),
    period: z
      .enum(["day", "week"])
      .nullable()
      .describe("How often its series publishes, or null for the requests routine"),
    state: z
      .enum(["present", "drifted", "missing"])
      .describe(
        "present; drifted once its prompt no longer runs its command; missing once deleted",
      ),
  })
  .strict();
export type LinkRoutine = z.output<typeof linkRoutineSchema>;

const routineSchema = z
  .object({
    template: z.enum(routineTemplateNames),
    title: z.string(),
    schedule: z
      .string()
      .describe("A 5-field cron with one fixed minute, the series' own once the link has one"),
    prompt: z.string().describe("One paragraph, to register exactly as it is"),
    registered: linkRoutineSchema
      .nullable()
      .describe(
        "The link's routine for it, or null when it has none. The bridge doesn't track the digest.",
      ),
  })
  .strict();
type Routine = z.output<typeof routineSchema>;

export const routinesResultSchema = z
  .object({
    linked: z.boolean().describe("Whether the Toy Box channel has a link"),
    routines: z.array(routineSchema).describe("The requests routine first"),
  })
  .strict();
export type RoutinesResult = z.output<typeof routinesResultSchema>;

export const routinesContract = commandContract({
  description: "Show the routines to register in Toy Box, with their prompts",
  roles: ["lead", "member", "operator"],
  scope: "channel",
  withoutSlack: true,
  input: z
    .object({
      template: z.enum(routineTemplateNames).optional().describe("Show only this routine"),
    })
    .strict(),
  result: routinesResultSchema,
  present: presentRoutines,
});

/** Each routine to register, ending with how to give the bridge its ID. */
export function presentRoutines({ linked, routines }: RoutinesResult): string {
  return [
    "Register a routine with set_routine, using the title, schedule and prompt shown for it, and change a schedule only if the owner asks.",
    ...routines.map((routine) => presentRoutine(routine, linked)),
  ].join("\n\n");
}

const purposes: Record<RoutineTemplateName, string> = {
  requests:
    "Every link needs it. The bridge runs it whenever requests need you, so its schedule is only a safety net.",
  digest:
    "Register it only if the owner wants Slack activity summarized here. Unless the link observes the whole channel with `--observe channel`, it sees only what allowlisted people post and request threads.",
  "release-notes": "Register it only if the owner wants release notes published in Slack.",
};

function presentRoutine(routine: Routine, linked: boolean): string {
  const fence = fenceFor(routine.prompt);
  return [
    `## ${routine.title}`,
    purposes[routine.template],
    `Title \`${routine.title}\`, schedule \`${routine.schedule}\`, prompt:`,
    `${fence}\n${routine.prompt}\n${fence}`,
    nextStep(routine, linked),
  ].join("\n\n");
}

function nextStep({ template, registered }: Routine, linked: boolean): string {
  if (template === "digest") return "The bridge doesn't need its ID.";
  const requests = template === "requests";
  const tell = requests
    ? "`toy-box-slack routine --requests <routineId>`"
    : `\`toy-box-slack routine --publish <routineId> --series ${RELEASE_NOTES_SERIES} --period ${registered?.period ?? "week"}\``;
  const returned = "with the routineId set_routine returned";
  if (registered?.state === "missing") {
    return `The link's routine ${registered.routineId} was deleted, so register this one, then run ${tell} ${returned}.`;
  }
  if (registered) {
    const command = requests ? REQUESTS_COMMAND : publishCommand(RELEASE_NOTES_SERIES);
    const drift =
      registered.state === "drifted" ? `, but its prompt no longer runs \`${command}\`` : "";
    return `The link uses routine ${registered.routineId}${drift}. To update it in place, pass routineId ${registered.routineId} to set_routine with this prompt, keeping its title and schedule. To replace it, register this one, then run ${tell} ${returned}.`;
  }
  if (requests) {
    return "Then have the owner link the channel with `toy-box-slack link --slack-channel <id> --routine <routineId>`, passing the Slack channel's ID and the routineId set_routine returned.";
  }
  const daily = `For daily notes, schedule it \`${releaseNotesSchedules.day}\` and pass \`--period day\`.`;
  return `${linked ? "Then" : "Once the channel is linked,"} run ${tell} ${returned}. ${daily}`;
}

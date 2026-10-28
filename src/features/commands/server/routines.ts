// The routines command.
//
// Routines reads only the caller's link, so it answers while Slack is down and before the link it
// helps set up exists. A release notes routine the link has keeps its schedule, which the bridge
// follows as the routine is edited, so registering it again doesn't undo the owner's choice.

import type { BridgeDatabase } from "@bridge/server/database";
import type { CommandHandler } from "@commands/model/contract";
import type { LinkRoutine, routinesContract } from "@commands/model/routines";
import {
  RELEASE_NOTES_SERIES,
  routineTemplateNames,
  routineTemplates,
  type RoutineTemplateName,
} from "@toybox/model/routines";

export type RoutinesCommandOptions = {
  database: BridgeDatabase;
};

type StoredRoutine = LinkRoutine & { schedule: string | null };

/** Every routine template, or one, with the routine the caller's link has for it. */
export function routinesCommand({
  database,
}: RoutinesCommandOptions): CommandHandler<typeof routinesContract> {
  return async ({ template }, { caller }) => {
    const stored = await database.read((sql) => readLinkRoutines(sql, caller.channelId));
    return {
      linked: stored !== null,
      routines: (template ? [template] : routineTemplateNames).map((name) => {
        const { title, schedule, prompt } = routineTemplates[name];
        const routine = stored?.[name] ?? null;
        return {
          template: name,
          title,
          schedule: routine?.schedule ?? schedule,
          prompt,
          registered: routine && {
            routineId: routine.routineId,
            period: routine.period,
            state: routine.state,
          },
        };
      }),
    };
  };
}

/** The routine the channel's link has for each template, or null when it has no link. */
async function readLinkRoutines(
  sql: Bun.SQL,
  channelId: string,
): Promise<Record<RoutineTemplateName, StoredRoutine | null> | null> {
  const [link] = await sql<{ id: string; routineId: string; state: LinkRoutine["state"] }[]>`
    SELECT id, requests_routine_id AS routineId, routine_state AS state FROM links
    WHERE toybox_channel_id = ${channelId}
  `;
  if (!link) return null;
  const [releaseNotes] = await sql<StoredRoutine[]>`
    SELECT routine_id AS routineId, period, routine_state AS state, schedule FROM link_routines
    WHERE link_id = ${link.id} AND series = ${RELEASE_NOTES_SERIES}
  `;
  return {
    requests: { routineId: link.routineId, period: null, state: link.state, schedule: null },
    digest: null,
    "release-notes": releaseNotes ?? null,
  };
}

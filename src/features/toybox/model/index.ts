// Toy Box's channel API as the bridge reads it.
//
// The schemas mirror the toy-box repo's src/features/channels/model/index.ts (ChannelState and
// ChannelEvent). They require only what the bridge acts on and strip the rest, so a Toy Box that
// adds fields still parses.

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

const routineSchema = z.object({
  id: z.string(),
  title: z.string(),
  schedule: z.string(),
  prompt: z.string(),
});
export type ToyBoxRoutine = z.output<typeof routineSchema>;

/**
 * The frame GET /api/v1/channels/:id starts with when read from scratch, the only place Toy Box
 * shows a channel's routines: a snapshot, or word that the channel is gone (stream.ts in the
 * toy-box repo's src/features/channels/server).
 */
export const firstFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), state: z.object({ routines: z.array(routineSchema) }) }),
  z.object({ type: z.literal("deleted") }),
]);

/** The command the routine that wakes a lead runs. */
export const REQUESTS_COMMAND = "toy-box-slack inbox";

/** The command a routine that publishes runs, followed by the name of what it publishes. */
export const PUBLISH_COMMAND = "toy-box-slack publish --series";

/** The first of `routines` whose prompt runs `command`, which is the routine the bridge runs. */
export function findRoutine<Routine extends { prompt: string }>(
  routines: readonly Routine[],
  command: string,
): Routine | undefined {
  // The lead may rewrap a prompt, and a command whose name only starts with this one doesn't count.
  const words = command.split(" ").map((word) => RegExp.escape(word));
  const pattern = new RegExp(`(?<![\\w-])${words.join("\\s+")}(?![\\w-])`);
  return routines.find(({ prompt }) => pattern.test(prompt));
}

/**
 * The latest time at or before `now` that `schedule` runs. Toy Box reads schedules in local time
 * (src/shared/cron.ts in the toy-box repo), so this does too.
 */
export function latestScheduledRun(schedule: string, now: number): number {
  // prev() looks strictly before its start, so starting just after now includes a run at now.
  return CronExpressionParser.parse(schedule, { currentDate: new Date(now + 1) })
    .prev()
    .getTime();
}

/**
 * What Toy Box did with a routine run. A call that can't connect or times out is `failed`, like a
 * 5xx, and any 4xx but a 404 is `refused`, since asking again would be refused again.
 */
export type RoutineRunOutcome = "ran" | "missing" | "failed" | "refused";

/** Reads POST /api/v1/channels/:id/routines/:routineId/run's status. */
export function routineRunOutcome(status: number): RoutineRunOutcome {
  if (status >= 200 && status < 300) return "ran";
  // Toy Box answers 404 for a missing routine and for a missing channel alike.
  if (status === 404) return "missing";
  return status >= 400 && status < 500 ? "refused" : "failed";
}

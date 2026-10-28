// Waking a lead.
//
// The bridge reaches a lead only by running a routine in its channel, which Toy Box delivers to the
// lead privately with the routine's prompt. The lead registers that routine itself and may replace
// it at any time, so every wake reads the channel's routines again and runs the one whose prompt
// runs inbox, rather than an ID the bridge stored.

import { findRoutine, REQUESTS_COMMAND, type RoutineRunOutcome } from "@toybox/model";
import { readToyBoxRoutines, runToyBoxRoutine } from "./api";

/** Runs the channel's routine that reads Slack requests, which wakes the channel's lead. */
export async function wakeLead(origin: URL, channelId: string): Promise<RoutineRunOutcome> {
  try {
    const routines = await readToyBoxRoutines(origin, channelId);
    const routine = routines && findRoutine(routines, REQUESTS_COMMAND);
    return routine ? await runToyBoxRoutine(origin, channelId, routine.id) : "missing";
  } catch (error) {
    console.error(`Calling Toy Box for channel ${channelId} failed:`, error);
    return "failed";
  }
}

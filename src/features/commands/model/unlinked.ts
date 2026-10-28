// What commands say in a Toy Box channel with no link.
//
// Only the lead manages a channel's routines, so unlinking leaves them alone, and so does a
// proposal to link the channel that ends without applying. A routine that runs toy-box-slack in a
// channel with no link only wakes the lead for nothing, so unlink and every command a routine runs
// tell the lead to delete those routines unless the owner means to link the channel. They say it
// in the words the skill quotes. Only a lead has delete_routine, so nobody else is told to.

import type { CallerRole } from "./callers";

/** Tells the lead to delete the channel's toy-box-slack routines, after a sentence about it. */
export const deleteUnlinkedRoutines =
  "Unless the owner means to link it, use delete_routine on the routines here that run toy-box-slack, so they stop waking you for nothing.";

/**
 * Says the caller's Toy Box channel isn't linked to Slack, with what that leaves the command when
 * it says, and tells a lead to delete the channel's toy-box-slack routines.
 */
export function notLinked(role: CallerRole, consequence?: string): string {
  const unlinked = `This Toy Box channel isn't linked to Slack${consequence ? `, ${consequence}` : ""}.`;
  return role === "lead" ? `${unlinked} ${deleteUnlinkedRoutines}` : unlinked;
}

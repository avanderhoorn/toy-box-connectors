// Toy Box's channel API as the bridge reads it.
//
// The schemas mirror the toy-box repo's src/features/channels/model/index.ts (ChannelState,
// ChannelEvent and ChannelObservationEvent) and server/api.ts (listChannelsResponse). They require
// only what the bridge acts on and strip the rest, so a Toy Box that adds fields still parses.

import { z } from "zod";

/** GET /api/v1/channels. A lead's session ID is its channel's ID. */
export const toyBoxCatalogSchema = z.object({
  version: z.literal(1),
  channels: z.array(
    z.object({ id: z.string(), name: z.string(), model: z.object({ provider: z.string() }) }),
  ),
  members: z.array(z.object({ id: z.string(), channelId: z.string(), name: z.string() })),
  working: z.array(z.string()),
});
export type ToyBoxCatalog = z.output<typeof toyBoxCatalogSchema>;

/** How an agent appears in its channel. Mirrors Toy Box's ChannelAgentPresence. */
export const agentPresenceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("working"), text: z.string().optional() }),
  z.object({ state: z.literal("waiting"), text: z.string(), wakeAt: z.string().optional() }),
  z.object({ state: z.literal("idle") }),
]);
export type AgentPresence = z.output<typeof agentPresenceSchema>;

const routineSchema = z.object({
  id: z.string(),
  title: z.string(),
  schedule: z.string(),
  prompt: z.string(),
});
export type ToyBoxRoutine = z.output<typeof routineSchema>;

// Conversation messages carry text and system messages carry an object, so content stays unknown
// until a reader narrows it.
const messageSchema = z.object({
  timestamp: z.string(),
  sender: z.object({ type: z.string() }),
  content: z.unknown(),
});
export type ToyBoxMessage = z.output<typeof messageSchema>;

const revisionSchema = z.number().int().nonnegative();

// Presence values stay unknown here so one agent's unfamiliar state can't drop the whole frame.
const presenceMapSchema = z.record(z.string(), z.unknown());

/** One frame of GET /api/v1/channels/:id, the events the bridge acts on. */
export const channelFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    state: z.object({
      revision: revisionSchema,
      channel: z.object({ model: z.object({ provider: z.string() }) }),
      messages: z.array(messageSchema),
      routines: z.array(routineSchema),
      presence: presenceMapSchema,
    }),
  }),
  z.object({ type: z.literal("resumed"), presence: presenceMapSchema }),
  z.object({ type: z.literal("presence"), presence: presenceMapSchema }),
  z.object({ type: z.literal("message"), revision: revisionSchema, message: messageSchema }),
  z.object({
    type: z.literal("model"),
    revision: revisionSchema,
    model: z.object({ provider: z.string() }),
  }),
  z.object({
    type: z.enum(["reaction", "tasks", "read", "member", "status"]),
    revision: revisionSchema,
  }),
  z.object({ type: z.literal("deleted"), channelId: z.string() }),
]);
export type ChannelFrame = z.output<typeof channelFrameSchema>;

/** A routine change Toy Box announces with a system message. */
export const routineChangeSchema = z.object({
  type: z.enum(["routine_scheduled", "routine_edited", "routine_deleted"]),
  routine: routineSchema,
});
export type RoutineChange = z.output<typeof routineChangeSchema>;

/** Whether a routine the lead registered still exists and still runs the command it's for. */
export type RoutineState = "present" | "drifted" | "missing";

/** The command a link's requests routine must run. */
export const REQUESTS_COMMAND = "toy-box-slack inbox";

/** The command a publication series' routine must run. */
export function publishCommand(series: string): string {
  return `toy-box-slack publish --series ${series}`;
}

/** Whether `routine` still exists and its prompt still runs `command`. Drift only warns. */
export function routineState(routine: { prompt: string } | null, command: string): RoutineState {
  if (!routine) return "missing";
  // The lead may rewrap a prompt, and a series whose name only starts with this one doesn't count.
  const words = command.split(" ").map((word) => RegExp.escape(word));
  const pattern = new RegExp(`(?<![\\w-])${words.join("\\s+")}(?![\\w-])`);
  return pattern.test(routine.prompt) ? "present" : "drifted";
}

/** What Toy Box did with a routine run. A connection that fails is `failed` too. */
export type RoutineRunOutcome = "ran" | "missing" | "failed" | "refused";

/** Reads POST /api/v1/channels/:id/routines/:routineId/run's status. */
export function routineRunOutcome(status: number): RoutineRunOutcome {
  if (status >= 200 && status < 300) return "ran";
  // Toy Box answers 404 for a missing routine and for a missing channel alike.
  if (status === 404) return "missing";
  if (status >= 500) return "failed";
  return "refused";
}

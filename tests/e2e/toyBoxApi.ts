// Toy Box's HTTP API as end-to-end tests call it.
//
// The schemas mirror ChannelObservationEvent and the routine system messages in the toy-box repo's
// src/features/channels/model/index.ts, ChannelAgentPresence in presence.ts, and the history page
// in src/features/channels/server/api.ts, keeping only what a test reads. Only the event stream
// parser is the bridge's, so a bug in how the bridge calls Toy Box can't hide in the harness that
// checks it.

import { readServerSentEvents } from "@toybox/server/sse";
import { z } from "zod";

// Toy Box answers on loopback, so a request this slow has failed rather than queued.
const REQUEST_TIMEOUT = 30_000;

const presenceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("working"), text: z.string().optional() }),
  z.object({ state: z.literal("waiting"), text: z.string(), wakeAt: z.string().optional() }),
  z.object({ state: z.literal("idle") }),
]);
/** How an agent appears in its channel. */
export type Presence = z.output<typeof presenceSchema>;

const routineSchema = z.object({ id: z.string(), title: z.string() });
export type Routine = z.output<typeof routineSchema>;

/** A routine change Toy Box announces with a system message. */
export const routineChangeSchema = z.object({
  type: z.enum(["routine_scheduled", "routine_edited", "routine_deleted"]),
  routine: routineSchema,
});

// System messages carry an object, so content stays unknown until a reader narrows it.
const messageSchema = z.object({ sender: z.object({ type: z.string() }), content: z.unknown() });
export type Message = z.output<typeof messageSchema>;

const presenceMapSchema = z.record(z.string(), presenceSchema);

const frameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    state: z.object({
      messages: z.array(messageSchema),
      routines: z.array(routineSchema),
      presence: presenceMapSchema,
    }),
  }),
  z.object({ type: z.enum(["resumed", "presence"]), presence: presenceMapSchema }),
  z.object({ type: z.literal("message"), message: messageSchema }),
  z.object({ type: z.enum(["reaction", "tasks", "model", "read", "member", "status", "deleted"]) }),
]);
/** One frame of a channel's event stream. */
export type Frame = z.output<typeof frameSchema>;

const historySchema = z.object({ messages: z.array(messageSchema) });

/** Calls `path` under /api/v1, and resolves with Toy Box's answer once it has `expected` status. */
export async function callToyBox(
  origin: URL,
  path: string,
  {
    method = "GET",
    body,
    expected = 200,
  }: { method?: "GET" | "POST"; body?: object; expected?: number } = {},
): Promise<Response> {
  const response = await fetch(new URL(`/api/v1/${path}`, origin), {
    method,
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (response.status !== expected) {
    const answer = await response.text();
    throw new Error(`Toy Box answered ${response.status} to ${method} /api/v1/${path}: ${answer}`);
  }
  return response;
}

/** Channel `channelId`'s latest 100 messages, oldest first, as Toy Box stored them. */
export async function readLatestMessages(origin: URL, channelId: string) {
  const path = `channels/${channelId}/messages?before=${Number.MAX_SAFE_INTEGER}`;
  return historySchema.parse(await (await callToyBox(origin, path)).json()).messages;
}

/** Channel `channelId`'s event stream, from a snapshot on, until `signal` aborts. */
export async function* readChannelFrames(
  origin: URL,
  channelId: string,
  signal: AbortSignal,
): AsyncGenerator<Frame> {
  const response = await fetch(new URL(`/api/v1/channels/${channelId}`, origin), {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (response.status !== 200 || !response.body) {
    throw new Error(`Toy Box answered ${response.status} for channel ${channelId}'s stream.`);
  }
  for await (const { data } of readServerSentEvents(response.body)) {
    yield frameSchema.parse(JSON.parse(data));
  }
}

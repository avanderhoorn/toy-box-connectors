// Toy Box's HTTP API as the bridge calls it.
//
// The bridge reads a channel and runs one of its routines, and calls nothing else. Every URL is a path
// on the loopback origin the bridge started with, and redirects aren't followed, so no request
// leaves this Mac. The routes are the toy-box repo's src/features/channels/routes/v1/channels, and
// their handlers are in src/features/channels/server/api.ts.

import {
  firstFrameSchema,
  routineRunOutcome,
  type RoutineRunOutcome,
  type ToyBoxChannel,
} from "@toybox/model";
import { readServerSentEvents } from "./sse";

// Toy Box answers on loopback, so a call this slow has failed rather than queued.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The channel, with its routines oldest first, or null when Toy Box has no such channel. Toy Box
 * shows routines only in the snapshot its event stream starts with (getChannelResponse), so this
 * reads that first frame and closes the stream.
 */
export async function readToyBoxChannel(
  origin: URL,
  channelId: string,
): Promise<ToyBoxChannel | null> {
  const response = await fetch(channelsUrl(origin, channelId), {
    headers: { Accept: "text/event-stream" },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const type = response.headers.get("Content-Type") ?? "";
  if (response.status !== 200 || !response.body || !type.startsWith("text/event-stream")) {
    await response.body?.cancel();
    throw new Error(
      `Toy Box answered ${response.status} ${type || "without a type"} for channel ${channelId}'s stream.`,
    );
  }
  // Leaving the loop cancels the body, which closes the stream.
  for await (const { data } of readServerSentEvents(response.body)) {
    const frame = firstFrameSchema.parse(JSON.parse(data));
    if (frame.type === "deleted") return null;
    const { channel, routines } = frame.state;
    return { name: channel.name, provider: channel.model.provider, routines };
  }
  throw new Error(`Toy Box closed channel ${channelId}'s stream before it sent anything.`);
}

/**
 * POST /api/v1/channels/:id/routines/:routineId/run, which starts a turn for the channel's lead or
 * steers into its running one. Any answer but a run or a missing routine is logged, since status
 * points the owner to the log for why.
 */
export async function runToyBoxRoutine(
  origin: URL,
  channelId: string,
  routineId: string,
): Promise<RoutineRunOutcome> {
  const response = await fetch(channelsUrl(origin, channelId, "routines", routineId, "run"), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const outcome = routineRunOutcome(response.status);
  if (outcome === "ran" || outcome === "missing") {
    await response.body?.cancel();
  } else {
    const answer = (await response.text()).slice(0, 500);
    console.error(
      `Toy Box answered ${response.status} to running routine ${routineId} in channel ${channelId}: ${answer}`,
    );
  }
  return outcome;
}

function channelsUrl(origin: URL, ...segments: string[]): URL {
  const path = ["api", "v1", "channels", ...segments].map(encodeURIComponent).join("/");
  return new URL(`/${path}`, origin);
}

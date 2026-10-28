// Toy Box's HTTP API as the bridge calls it.
//
// The bridge reads the channel catalog, follows channel streams and runs routines, and calls
// nothing else. Every URL is a path on the loopback origin the bridge started with, and redirects
// aren't followed, so no request leaves this Mac.

import {
  routineRunOutcome,
  toyBoxCatalogSchema,
  type RoutineRunOutcome,
  type ToyBoxCatalog,
} from "@toybox/model";

// Toy Box answers on loopback, so a call this slow has failed rather than queued.
const REQUEST_TIMEOUT_MS = 15_000;

/** Toy Box answered, but not with what the bridge asked for. */
export class ToyBoxResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ToyBoxResponseError";
  }
}

/** GET /api/v1/channels, the channels and members that resolve a caller's session. */
export async function fetchToyBoxCatalog(origin: URL): Promise<ToyBoxCatalog> {
  const response = await fetch(channelsUrl(origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ToyBoxResponseError(
      `Toy Box answered ${response.status} for its channel list.`,
      response.status,
    );
  }
  return toyBoxCatalogSchema.parse(await response.json());
}

/**
 * GET /api/v1/channels/:id, the channel's event stream. Toy Box replays what came after `revision`
 * when it still can, and otherwise starts with a snapshot. Toy Box sends a keepalive every 5
 * seconds, so the stream fails once it has been quiet for `idleTimeout` while the caller waits.
 */
export async function* readChannelStream(
  origin: URL,
  channelId: string,
  revision: number | null,
  { signal, idleTimeout }: { signal: AbortSignal; idleTimeout: number },
): AsyncGenerator<Uint8Array> {
  const quiet = new AbortController();
  const listen = () =>
    setTimeout(() => {
      quiet.abort(
        new Error(`Toy Box sent nothing on channel ${channelId}'s stream for ${idleTimeout} ms.`),
      );
    }, idleTimeout);
  let timer = listen();
  try {
    const response = await fetch(channelsUrl(origin, channelId), {
      headers: {
        Accept: "text/event-stream",
        ...(revision === null ? {} : { "Last-Event-ID": String(revision) }),
      },
      redirect: "manual",
      signal: AbortSignal.any([signal, quiet.signal]),
    });
    const type = response.headers.get("Content-Type") ?? "";
    if (response.status !== 200 || !response.body || !type.startsWith("text/event-stream")) {
      await response.body?.cancel();
      throw new ToyBoxResponseError(
        `Toy Box answered ${response.status} ${type || "without a type"} for channel ${channelId}'s stream.`,
        response.status,
      );
    }
    for await (const chunk of response.body) {
      // Time the caller spends on a chunk isn't silence.
      clearTimeout(timer);
      yield chunk;
      timer = listen();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/v1/channels/:id/routines/:routineId/run, which starts a turn for the channel's lead or
 * steers into its running one. A call that can't connect or times out failed.
 */
export async function runToyBoxRoutine(
  origin: URL,
  channelId: string,
  routineId: string,
): Promise<RoutineRunOutcome> {
  try {
    const response = await fetch(channelsUrl(origin, channelId, "routines", routineId, "run"), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return routineRunOutcome(response.status);
  } catch {
    return "failed";
  }
}

function channelsUrl(origin: URL, ...segments: string[]): URL {
  const path = ["api", "v1", "channels", ...segments].map(encodeURIComponent).join("/");
  return new URL(`/${path}`, origin);
}

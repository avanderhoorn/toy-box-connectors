// A protocol fake of the two Toy Box routes the bridge calls, answered the way the toy-box repo's
// handlers in src/features/channels/server/api.ts answer them.
//
// GET /api/v1/channels/:id follows getChannelResponse: an event stream, framed by
// src/shared/server/sse.ts, that starts with the channel's snapshot (streamChannel in
// server/stream.ts) and stays open, or that says the channel is deleted and ends.
// POST /api/v1/channels/:id/routines/:routineId/run follows runChannelRoutineResponse: 204 once
// runChannelRoutine in server/index.ts wakes the lead, or 404 for a routine the channel doesn't
// have, including every routine of a channel that's gone.

export type FakeRoutine = { id: string; title: string; schedule: string; prompt: string };

/** A channel's title, and the provider its lead runs on, which is Copilot unless set. */
export type FakeChannelSettings = { name?: string; provider?: string };

type FakeChannel = Required<FakeChannelSettings> & { routines: FakeRoutine[] };

/** A routine run Toy Box accepted. */
export type FakeRun = { channelId: string; routineId: string; at: number };

export type FakeToyBox = ReturnType<typeof startFakeToyBox>;

const encoder = new TextEncoder();

/** Starts a fake Toy Box on an ephemeral loopback port. */
export function startFakeToyBox() {
  const channels = new Map<string, FakeChannel>();
  const runs: FakeRun[] = [];
  const failures: number[] = [];
  let open = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: route });

  function route(request: Request): Response {
    const path = new URL(request.url).pathname.split("/").slice(1).map(decodeURIComponent);
    const [api, version, resource, channelId, routines, routineId, run] = path;
    if (api !== "api" || version !== "v1" || resource !== "channels" || !channelId?.trim()) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "GET" && path.length === 4) return stream(channelId);
    if (
      request.method === "POST" &&
      path.length === 7 &&
      routines === "routines" &&
      run === "run"
    ) {
      return runRoutine(channelId, routineId!);
    }
    return new Response("Not Found", { status: 404 });
  }

  function stream(channelId: string): Response {
    const channel = channels.get(channelId);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        if (!channel) {
          controller.enqueue(encoder.encode(frame({ type: "deleted", channelId })));
          controller.close();
          return;
        }
        open += 1;
        controller.enqueue(
          encoder.encode(
            `id: 1\n${frame({ type: "snapshot", state: snapshot(channelId, channel) })}`,
          ),
        );
      },
      cancel() {
        open -= 1;
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  function runRoutine(channelId: string, routineId: string): Response {
    const failure = failures.shift();
    if (failure !== undefined) {
      return Response.json({ error: "Unable to run routine." }, { status: failure });
    }
    if (!channels.get(channelId)?.routines.some(({ id }) => id === routineId)) {
      return Response.json({ error: "Routine not found." }, { status: 404 });
    }
    runs.push({ channelId, routineId, at: Date.now() });
    return new Response(null, { status: 204 });
  }

  return {
    url: server.url.href,
    runs,
    addChannel({ name = "Linked", provider = "copilot" }: FakeChannelSettings = {}) {
      const channelId = crypto.randomUUID();
      channels.set(channelId, { name, provider, routines: [] });
      return channelId;
    },
    scheduleRoutine(channelId: string, input: Omit<FakeRoutine, "id">) {
      const routine = { id: crypto.randomUUID(), ...input, prompt: input.prompt.trim() };
      channels.get(channelId)!.routines.push(routine);
      return routine;
    },
    deleteChannel(channelId: string) {
      channels.delete(channelId);
    },
    failNextRun(status = 500) {
      failures.push(status);
    },
    openStreams: () => open,
    stop: () => server.stop(true),
  };
}

function frame(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// The snapshot's fields as ChannelState has them in src/features/channels/model/index.ts. The
// bridge reads only the channel's name and provider, and the routines.
function snapshot(channelId: string, { name, provider, routines }: FakeChannel) {
  return {
    revision: 1,
    channel: { id: channelId, name, model: { provider, name: "model" }, tasks: [] },
    lead: { id: channelId, name: "Lead" },
    members: [],
    messages: [],
    request: null,
    artifacts: [],
    routines,
    presence: { [channelId]: { state: "idle" } },
  };
}

// A protocol fake of Toy Box's channel API.
//
// It answers the routes the bridge calls the way the toy-box repo's handlers do, and nothing more.
// GET /api/v1/channels follows listChannelsResponse in src/features/channels/server/api.ts. A
// channel's stream at GET /api/v1/channels/:id follows getChannelResponse and streamChannel in
// server/stream.ts, framed by src/shared/server/sse.ts, with the replay ring of server/events.ts.
// POST /api/v1/channels/:id/routines/:routineId/run follows runChannelRoutineResponse and
// wakeChannelAgent in server/index.ts. Members join and leave with the system messages that
// createMember and deleteMember in server/database.ts append. Stopping it drops every connection
// and keeps only what Toy Box stores durably, like a restart, and starting it again clears working
// statuses as server/startup.ts does.

const CHANNEL_LEAD_PROFILE = {
  name: "Lead",
  role: "Own the channel purpose and coordinate the work.",
  avatar: {
    mark: "M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3z",
    color: "#1e3a8a",
    ink: "#facc15",
  },
};
const MAX_REPLAY_EVENTS = 500;
const HEARTBEAT_INTERVAL_MS = 5_000;
const encoder = new TextEncoder();

export type FakeRoutine = { id: string; title: string; schedule: string; prompt: string };
export type FakeStatus =
  | { state: "working"; text: string }
  | { state: "waiting"; text: string; wakeAt?: string };
type Presence = { state: "working"; text?: string } | FakeStatus | { state: "idle" };
type Message = {
  id: string;
  sequence: number;
  timestamp: string;
  sender: { type: "user" } | { type: "system" };
  content: unknown;
};
type ChannelEvent = (
  | { type: "message"; message: Message }
  | { type: "status"; agentId: string; status?: FakeStatus }
  | { type: "poll"; pollId: string }
) & { revision: number };

type Subscriber = {
  presence: Record<string, Presence> | undefined;
  send(event: unknown, id?: number): void;
  close(): void;
};

type Channel = {
  id: string;
  name: string;
  model: { provider: string; name: string };
  members: { id: string; channelId: string; name: string }[];
  revision: number;
  sequence: number;
  messages: Message[];
  routines: FakeRoutine[];
  status: FakeStatus | undefined;
  running: boolean;
  history: ChannelEvent[];
  subscribers: Set<Subscriber>;
  updatedAt: string;
};

/** A routine run Toy Box accepted, from the run endpoint or from its own schedule. */
export type FakeRun = { channelId: string; routineId: string; by: "api" | "schedule"; at: number };

/** A stream request, the revision it asked to resume after, and how the fake answered it. */
export type FakeStreamRequest = {
  channelId: string;
  after: string | null;
  answer: "snapshot" | "resumed" | "deleted";
};

/** A stream request the fake refused, and the `performance.now()` it arrived at. */
export type FakeRefusedStream = { channelId: string; at: number };

export type FakeToyBox = {
  readonly url: string;
  readonly runs: readonly FakeRun[];
  readonly streamRequests: readonly FakeStreamRequest[];
  readonly refusedStreams: readonly FakeRefusedStream[];
  /** How many times the catalog was asked for. */
  readonly catalogReads: number;
  /** Adds a channel whose lead runs on `provider`, and returns its ID, which its lead shares. */
  addChannel(options?: { provider?: string; name?: string }): string;
  /** Adds a member to a channel and returns its session ID, announcing it as createMember does. */
  addMember(channelId: string, name: string): string;
  /** Removes a member, announcing it as deleteMember does. */
  removeMember(memberId: string): void;
  /**
   * Reads the catalog as each request arrives but holds every answer until the returned release
   * is called, so a test can change members while a read is on its way back.
   */
  holdCatalog(): () => void;
  scheduleRoutine(channelId: string, routine: Omit<FakeRoutine, "id">): FakeRoutine;
  editRoutine(
    channelId: string,
    routineId: string,
    changes: Partial<Omit<FakeRoutine, "id">>,
  ): void;
  deleteRoutine(channelId: string, routineId: string): void;
  /** Posts as the channel's owner, Toy Box's one user. */
  postOwnerMessage(channelId: string, text: string): void;
  /** Sets the lead's status, as set_agent_status and finish_agent_turn do. */
  setLeadStatus(channelId: string, status: FakeStatus | undefined): void;
  /** Starts a lead turn without a routine, as a delivered message does. */
  startTurn(channelId: string): void;
  /** Ends the lead's turn, waiting for `waiting` when given, as finish_agent_turn does. */
  finishTurn(channelId: string, waiting?: { text: string; wakeAt?: string }): void;
  /** Commits an event of a type a newer Toy Box might add, which the bridge can't read. */
  commitNewKindOfEvent(channelId: string): void;
  /** Runs a routine the way Toy Box's own schedule does. */
  runScheduled(channelId: string, routineId: string): void;
  /** Answers the next run call with `status` instead of running the routine. */
  failNextRun(status?: number): void;
  /**
   * Drops every open stream and answers each new stream request with `status` until
   * `acceptStreams`. Unlike a stopped fake, whose refused connections can't be counted, it records
   * when each request arrived, so a test can time the client's retries.
   */
  refuseStreams(status?: number): void;
  acceptStreams(): void;
  deleteChannel(channelId: string): void;
  /** How many streams are open for the channel. */
  connections(channelId: string): number;
  /** Stops answering and drops every connection, keeping what Toy Box stores durably. */
  stop(): Promise<void>;
  /** Starts again on the same port after `stop`, like Toy Box after a restart. */
  start(): void;
};

/** Starts a fake Toy Box on an ephemeral loopback port. `now` stamps messages and runs. */
export function startFakeToyBox(options: { now?: () => number } = {}): FakeToyBox {
  const now = options.now ?? Date.now;
  const channels = new Map<string, Channel>();
  const runs: FakeRun[] = [];
  const streamRequests: FakeStreamRequest[] = [];
  const refusedStreams: FakeRefusedStream[] = [];
  let catalogReads = 0;
  let catalogHeld: Promise<void> | undefined;
  const failures: number[] = [];
  let refusal: number | undefined;
  let server = serve(0);
  const port = server.port!;

  function serve(port: number) {
    return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: route });
  }

  function route(request: Request): Response | Promise<Response> {
    const path = new URL(request.url).pathname.split("/").slice(1).map(decodeURIComponent);
    const [api, version, resource, channelId, routines, routineId, run] = path;
    if (api !== "api" || version !== "v1" || resource !== "channels") return notFound();
    if (request.method === "GET" && (channelId === undefined || channelId === "")) {
      catalogReads += 1;
      const answer = catalog();
      return catalogHeld ? catalogHeld.then(() => answer) : answer;
    }
    if (request.method === "GET" && path.length === 4) return stream(channelId!, request);
    if (
      request.method === "POST" &&
      routines === "routines" &&
      run === "run" &&
      path.length === 7
    ) {
      return runRoutine(channelId!, routineId!);
    }
    return notFound();
  }

  function catalog(): Response {
    const list = [...channels.values()];
    return Response.json(
      {
        version: 1,
        channels: list.map(channelOf),
        members: list.flatMap(({ members }) => members),
        lead: CHANNEL_LEAD_PROFILE,
        working: list.filter(({ running }) => running).map(({ id }) => id),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  function stream(channelId: string, request: Request): Response {
    if (!isDurableId(channelId)) return invalidRequest();
    if (refusal !== undefined) {
      refusedStreams.push({ channelId, at: performance.now() });
      return Response.json({ error: "Unable to stream Channel." }, { status: refusal });
    }
    const after =
      request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
    let subscriber: Subscriber | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          if (subscriber) channels.get(channelId)?.subscribers.delete(subscriber);
          try {
            controller.close();
          } catch {
            // The client already went away.
          }
        };
        subscriber = {
          presence: undefined,
          send(event, id) {
            if (closed) return;
            const field = id === undefined ? "" : `id: ${id}\n`;
            controller.enqueue(encoder.encode(`${field}data: ${JSON.stringify(event)}\n\n`));
          },
          close,
        };
        request.signal.addEventListener("abort", close, { once: true });
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        const answer = establish(channelId, subscriber, readAfterRevision(after));
        streamRequests.push({ channelId, after, answer });
        if (closed) return;
        heartbeat = setInterval(
          () => !closed && controller.enqueue(encoder.encode(": keepalive\n\n")),
          HEARTBEAT_INTERVAL_MS,
        );
      },
      cancel() {
        subscriber?.close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  function establish(
    channelId: string,
    subscriber: Subscriber,
    after: number | undefined,
  ): FakeStreamRequest["answer"] {
    const channel = channels.get(channelId);
    if (!channel) {
      subscriber.send({ type: "deleted", channelId });
      subscriber.close();
      return "deleted";
    }
    channel.subscribers.add(subscriber);
    const replay = after === undefined ? undefined : replayEvents(channel, after);
    subscriber.presence = presenceOf(channel);
    if (replay) {
      for (const event of replay) subscriber.send(event, event.revision);
      subscriber.send({ type: "resumed", presence: subscriber.presence });
      return "resumed";
    }
    subscriber.send({ type: "snapshot", state: snapshotOf(channel) }, channel.revision);
    return "snapshot";
  }

  function runRoutine(channelId: string, routineId: string): Response {
    if (!isDurableId(channelId) || !isDurableId(routineId)) return invalidRequest();
    const failure = failures.shift();
    if (failure !== undefined) {
      return Response.json({ error: `Unable to run routine ${routineId}.` }, { status: failure });
    }
    const channel = channels.get(channelId);
    if (!channel?.routines.some(({ id }) => id === routineId)) {
      return Response.json({ error: "Routine not found." }, { status: 404 });
    }
    wake(channel, routineId, "api");
    return new Response(null, { status: 204 });
  }

  // deliverSessionMessage starts the turn before clearAgentStatus clears waiting, so presence moves
  // from waiting to working live and the cleared status changes nothing more.
  function wake(channel: Channel, routineId: string, by: FakeRun["by"]) {
    runs.push({ channelId: channel.id, routineId, by, at: now() });
    setRunning(channel, true);
    if (channel.status?.state === "waiting") changeStatus(channel, undefined);
  }

  function setRunning(channel: Channel, running: boolean) {
    channel.running = running;
    publishPresence(channel);
  }

  function changeStatus(channel: Channel, status: FakeStatus | undefined) {
    channel.status = status;
    commit(channel, { type: "status", agentId: channel.id, ...(status ? { status } : {}) });
  }

  function postMessage(channel: Channel, sender: Message["sender"], content: unknown) {
    channel.sequence += 1;
    const message = {
      id: crypto.randomUUID(),
      sequence: channel.sequence,
      timestamp: new Date(now()).toISOString(),
      sender,
      content,
    };
    channel.messages.push(message);
    commit(channel, { type: "message", message });
  }

  function commit(channel: Channel, change: DistributiveOmit<ChannelEvent, "revision">) {
    channel.revision += 1;
    channel.updatedAt = new Date(now()).toISOString();
    const event = { ...change, revision: channel.revision } as ChannelEvent;
    channel.history.push(event);
    if (channel.history.length > MAX_REPLAY_EVENTS) channel.history.shift();
    for (const subscriber of channel.subscribers) subscriber.send(event, event.revision);
    publishPresence(channel);
  }

  function publishPresence(channel: Channel) {
    const next = presenceOf(channel);
    for (const subscriber of channel.subscribers) {
      const changed = Object.fromEntries(
        Object.entries(next).filter(
          ([id, value]) => !Bun.deepEquals(subscriber.presence?.[id], value),
        ),
      );
      subscriber.presence = next;
      if (Object.keys(changed).length) subscriber.send({ type: "presence", presence: changed });
    }
  }

  function requireChannel(channelId: string): Channel {
    const channel = channels.get(channelId);
    if (!channel) throw new Error(`The fake Toy Box has no channel ${channelId}.`);
    return channel;
  }

  function requireRoutine(channel: Channel, routineId: string): FakeRoutine {
    const routine = channel.routines.find(({ id }) => id === routineId);
    if (!routine) throw new Error(`Channel ${channel.id} has no routine ${routineId}.`);
    return routine;
  }

  return {
    url: `http://127.0.0.1:${port}`,
    runs,
    streamRequests,
    refusedStreams,
    addChannel({ provider = "copilot", name = "Linked" } = {}) {
      const id = crypto.randomUUID();
      channels.set(id, {
        id,
        name,
        model: { provider, name: provider === "copilot" ? "claude-sonnet-5" : "model" },
        members: [],
        revision: 0,
        sequence: 0,
        messages: [],
        routines: [],
        status: undefined,
        running: false,
        history: [],
        subscribers: new Set(),
        updatedAt: new Date(now()).toISOString(),
      });
      return id;
    },
    get catalogReads() {
      return catalogReads;
    },
    addMember(channelId, name) {
      const channel = requireChannel(channelId);
      const member = { id: crypto.randomUUID(), channelId, name };
      channel.members.push(member);
      postMessage(channel, { type: "system" }, { type: "member_joined", member });
      return member.id;
    },
    removeMember(memberId) {
      const channel = [...channels.values()].find(({ members }) =>
        members.some(({ id }) => id === memberId),
      );
      if (!channel) throw new Error(`The fake Toy Box has no member ${memberId}.`);
      const member = channel.members.find(({ id }) => id === memberId)!;
      channel.members = channel.members.filter(({ id }) => id !== memberId);
      postMessage(channel, { type: "system" }, { type: "member_left", member });
    },
    holdCatalog() {
      const { promise, resolve } = Promise.withResolvers<void>();
      catalogHeld = promise;
      return () => {
        if (catalogHeld === promise) catalogHeld = undefined;
        resolve();
      };
    },
    scheduleRoutine(channelId, input) {
      const channel = requireChannel(channelId);
      const routine = { id: crypto.randomUUID(), ...input, prompt: input.prompt.trim() };
      channel.routines.push(routine);
      postMessage(channel, { type: "system" }, { type: "routine_scheduled", routine });
      return routine;
    },
    editRoutine(channelId, routineId, changes) {
      const channel = requireChannel(channelId);
      const routine = Object.assign(requireRoutine(channel, routineId), changes);
      postMessage(channel, { type: "system" }, { type: "routine_edited", routine: { ...routine } });
    },
    deleteRoutine(channelId, routineId) {
      const channel = requireChannel(channelId);
      const routine = requireRoutine(channel, routineId);
      channel.routines = channel.routines.filter(({ id }) => id !== routineId);
      postMessage(channel, { type: "system" }, { type: "routine_deleted", routine });
    },
    postOwnerMessage(channelId, text) {
      postMessage(requireChannel(channelId), { type: "user" }, text);
    },
    setLeadStatus(channelId, status) {
      changeStatus(requireChannel(channelId), status);
    },
    startTurn(channelId) {
      setRunning(requireChannel(channelId), true);
    },
    finishTurn(channelId, waiting) {
      const channel = requireChannel(channelId);
      if (waiting) changeStatus(channel, { state: "waiting", ...waiting });
      setRunning(channel, false);
      // startChannels clears a working status once the session goes idle.
      if (channel.status?.state === "working") changeStatus(channel, undefined);
    },
    commitNewKindOfEvent(channelId) {
      commit(requireChannel(channelId), { type: "poll", pollId: crypto.randomUUID() });
    },
    runScheduled(channelId, routineId) {
      const channel = requireChannel(channelId);
      requireRoutine(channel, routineId);
      wake(channel, routineId, "schedule");
    },
    failNextRun(status = 500) {
      failures.push(status);
    },
    refuseStreams(status = 500) {
      refusal = status;
      for (const channel of channels.values()) {
        for (const subscriber of channel.subscribers) subscriber.close();
      }
    },
    acceptStreams() {
      refusal = undefined;
    },
    deleteChannel(channelId) {
      const channel = requireChannel(channelId);
      channels.delete(channelId);
      for (const subscriber of channel.subscribers) {
        subscriber.send({ type: "deleted", channelId });
        subscriber.close();
      }
    },
    connections(channelId) {
      return channels.get(channelId)?.subscribers.size ?? 0;
    },
    async stop() {
      for (const channel of channels.values()) {
        for (const subscriber of channel.subscribers) subscriber.close();
        channel.history = [];
        channel.running = false;
      }
      await server.stop(true);
    },
    start() {
      server = serve(port);
      for (const channel of channels.values()) {
        if (channel.status?.state === "working") changeStatus(channel, undefined);
      }
    },
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function channelOf(channel: Channel) {
  return {
    id: channel.id,
    name: channel.name,
    model: channel.model,
    tasks: [],
    latestSequence: channel.sequence,
    seenThrough: 0,
    completedSequence: null,
    requestSequence: null,
    updatedAt: channel.updatedAt,
  };
}

function snapshotOf(channel: Channel) {
  return {
    revision: channel.revision,
    channel: channelOf(channel),
    lead: {
      id: channel.id,
      ...CHANNEL_LEAD_PROFILE,
      ...(channel.status ? { status: channel.status } : {}),
    },
    members: channel.members,
    messages: channel.messages.slice(-100),
    request: null,
    artifacts: [],
    routines: channel.routines.map((routine) => ({ ...routine })),
    presence: presenceOf(channel),
  };
}

// channelAgentPresence in src/features/channels/model/presence.ts. Members never run here.
function presenceOf(channel: Channel): Record<string, Presence> {
  const { status, running } = channel;
  const lead: Presence = running
    ? status?.state === "working"
      ? { state: "working", text: status.text }
      : { state: "working" }
    : status?.state === "waiting"
      ? status
      : { state: "idle" };
  return Object.fromEntries([
    [channel.id, lead],
    ...channel.members.map(({ id }) => [id, { state: "idle" }]),
  ]);
}

// replayChannelEvents in server/events.ts: a ring that can't cover the gap needs a snapshot.
function replayEvents(channel: Channel, after: number): ChannelEvent[] | undefined {
  if (after === channel.revision) return [];
  if (after > channel.revision) return undefined;
  const replay = channel.history.filter(({ revision }) => revision > after);
  return replay.length === channel.revision - after ? replay : undefined;
}

function readAfterRevision(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

function isDurableId(id: string): boolean {
  const trimmed = id.trim();
  return trimmed.length > 0 && trimmed.length <= 255;
}

function invalidRequest(): Response {
  return Response.json({ error: "Invalid Channel request." }, { status: 400 });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

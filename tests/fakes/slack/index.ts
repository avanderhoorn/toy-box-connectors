// A wire fake, not a second bridge implementation.
// Socket tickets, hello, envelopes, acks and disconnects:
// https://docs.slack.dev/apis/events-api/using-socket-mode/
// Installation authorizations and globally unique event IDs:
// https://docs.slack.dev/apis/events-api/#callback-field

import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { createFakeSlackApi, createFakeSlackStore } from "./api";
export type { FakeSlackChannel, FakeSlackUser, FakeSlackMessage } from "./api";

export type FakeSlackIdentity = {
  appId: string;
  teamId: string;
  enterpriseId: string | null;
  botId: string;
  botUserId: string;
};

export type FakeSlackCall = {
  method: string;
  args: Readonly<Record<string, unknown>>;
  token: string | null;
  at: number;
};

export type FakeSlackAck = {
  envelopeId: string;
  at: number;
  body: { envelope_id: string; payload?: unknown };
};

export type FakeSlackFailure =
  /** Slack explains a request it finds fault with in `messages`, as "[ERROR] ..." lines. */
  | { error: string; messages?: string[] }
  | { retryAfter: number }
  | { status: number }
  | { lostResponse: true }
  /** Slack posts a requested thread reply as a new root, and may also lose the response. */
  | { misplacedReply: true; lostResponse?: true };

export type FakeSlackDelivery = { envelopeId: string };

export type FakeEventOptions = {
  teamId?: string;
  appId?: string;
  /** Omit this option for our bot tuple; explicitly pass undefined to omit the wire field. */
  authorizations?: unknown;
  /** Additional outer callback fields, such as event_context or context_team_id. */
  context?: Record<string, unknown>;
};

export type FakeSlack = ReturnType<typeof startFakeSlack>;
export type FakeSlackApp = ReturnType<FakeSlack["addApp"]>;

type AckWaiter = { envelopeId: string; finish(ack: FakeSlackAck | null): void };
type AppConnection = {
  identity: FakeSlackIdentity;
  sockets: Map<number, ServerWebSocket<SocketData>>;
  connections: number[];
  acks: FakeSlackAck[];
  unacked: Set<string>;
  ackWaiters: Set<AckWaiter>;
  nextHelloAppId?: string;
  nextSocket: number;
};
type SocketData = { id: number; app: AppConnection };
const ackSchema = z
  .object({ envelope_id: z.string().min(1), payload: z.unknown().optional() })
  .strict();

export function startFakeSlack(
  options: {
    now?: () => number;
    identity?: Partial<FakeSlackIdentity>;
    pageSize?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const identity: FakeSlackIdentity = {
    appId: "AFAKE",
    teamId: "TFAKE",
    enterpriseId: null,
    botId: "BFAKE",
    botUserId: "UFAKEBOT",
    ...options.identity,
  };
  const store = createFakeSlackStore();
  const problems: string[] = [];
  const tickets = new Map<string, AppConnection>();
  const apps = new Map<
    string,
    { connection: AppConnection; api: ReturnType<typeof createFakeSlackApi> }
  >();
  const tokens = new Map<string, ReturnType<typeof createFakeSlackApi>>();
  let connectionSequence = 0;
  let stopped = false;
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: route,
    websocket: {
      sendPings: false,
      open(socket) {
        const app = socket.data.app;
        app.sockets.set(socket.data.id, socket);
        app.connections.push(socket.data.id);
        socket.send(
          JSON.stringify({
            type: "hello",
            connection_info: { app_id: app.nextHelloAppId ?? app.identity.appId },
            num_connections: app.sockets.size,
            debug_info: { host: "fake-slack", build_number: 1, approximate_connection_time: 3600 },
          }),
        );
        app.nextHelloAppId = undefined;
      },
      message(socket, bytes) {
        const app = socket.data.app;
        let value: unknown;
        try {
          value = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString());
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          problems.push("Socket client sent invalid JSON.");
          return;
        }
        const ack = ackSchema.safeParse(value);
        if (!ack.success) {
          problems.push(`Invalid Socket Mode ack: ${ack.error.message}`);
          return;
        }
        if (!app.unacked.delete(ack.data.envelope_id)) {
          problems.push(`Ack names an unknown or already acked envelope: ${ack.data.envelope_id}`);
          return;
        }
        const recorded = {
          envelopeId: ack.data.envelope_id,
          at: now(),
          body: ack.data,
        };
        app.acks.push(recorded);
        for (const waiter of app.ackWaiters) {
          if (waiter.envelopeId === recorded.envelopeId) waiter.finish(recorded);
        }
      },
      close(socket) {
        socket.data.app.sockets.delete(socket.data.id);
      },
    },
  });
  const url = new URL("/api/", server.url).href;
  const primary = createApp(
    identity,
    "xoxb-fake-for-local-tests-only",
    "xapp-fake-for-local-tests-only",
  );
  const heartbeat = setInterval(() => {
    for (const { connection } of apps.values()) {
      for (const socket of connection.sockets.values()) socket.ping("fake-slack");
    }
  }, 1000);

  async function route(request: Request): Promise<Response | undefined> {
    const target = new URL(request.url);
    if (target.pathname === "/socket") {
      const ticket = target.searchParams.get("ticket");
      const app = ticket ? tickets.get(ticket) : undefined;
      if (!ticket || !app) return new Response("Invalid ticket", { status: 403 });
      tickets.delete(ticket);
      if (server.upgrade(request, { data: { id: ++connectionSequence, app } })) return;
      return new Response("WebSocket upgrade required", { status: 400 });
    }
    if (!target.pathname.startsWith("/api/")) {
      problems.push(`Unexpected Slack route: ${target.pathname}`);
      return new Response("Unknown fake Slack route", { status: 404 });
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
    return (tokens.get(token ?? "") ?? apps.get(primary.appToken)!.api).handle(request);
  }

  function sendFrame(app: AppConnection, frame: Record<string, unknown>): FakeSlackDelivery {
    const available = [...app.sockets.values()];
    const socket = available[app.nextSocket++ % available.length];
    if (!socket) throw new Error("Fake Slack has no matching open socket.");
    const copy = structuredClone(frame);
    const envelopeId = typeof copy.envelope_id === "string" ? copy.envelope_id : "";
    if (envelopeId) app.unacked.add(envelopeId);
    socket.send(JSON.stringify(copy));
    return { envelopeId };
  }

  /** `event` framed as Slack sends it over Socket Mode. */
  function envelope(
    identity: FakeSlackIdentity,
    event: Record<string, unknown>,
    settings: FakeEventOptions = {},
  ) {
    const payload: Record<string, unknown> = {
      token: "fake-verification-token",
      context_team_id: identity.teamId,
      context_enterprise_id: identity.enterpriseId,
      is_ext_shared_channel: false,
      event_context: `fake-event-context-${crypto.randomUUID()}`,
      ...settings.context,
      type: "event_callback",
      api_app_id: settings.appId ?? identity.appId,
      team_id: settings.teamId ?? identity.teamId,
      event_id: `Ev${crypto.randomUUID()}`,
      event_time: Math.floor(now() / 1000),
      event: structuredClone(event),
    };
    if (Object.hasOwn(settings, "authorizations")) {
      if (settings.authorizations !== undefined)
        payload.authorizations = structuredClone(settings.authorizations);
    } else {
      payload.authorizations = [
        {
          enterprise_id: identity.enterpriseId,
          team_id: identity.teamId,
          user_id: identity.botUserId,
          is_bot: true,
          is_enterprise_install: false,
        },
      ];
    }
    return {
      type: "events_api",
      envelope_id: crypto.randomUUID(),
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload,
    };
  }

  function sendEvent(
    app: AppConnection,
    event: Record<string, unknown>,
    settings?: FakeEventOptions,
  ) {
    return sendFrame(app, envelope(app.identity, event, settings));
  }

  function broadcastEvent(event: Record<string, unknown>, context: Record<string, unknown> = {}) {
    const channelId = event.channel;
    if (typeof channelId !== "string" || !store.channels.has(channelId))
      throw new Error("A broadcast needs a seeded Slack channel.");
    const deliveries: (FakeSlackDelivery & { appId: string })[] = [];
    for (const { connection, api } of apps.values()) {
      const ownDeparture =
        event.type === "member_left_channel" && event.user === connection.identity.botUserId;
      if (connection.sockets.size && (api.isMember(channelId) || ownDeparture)) {
        deliveries.push({
          appId: connection.identity.appId,
          ...sendEvent(connection, event, { context }),
        });
      }
    }
    return deliveries;
  }

  function createApp(identity: FakeSlackIdentity, botToken: string, appToken: string) {
    if ([...apps.values()].some((app) => app.connection.identity.appId === identity.appId))
      throw new Error(`Slack app ${identity.appId} is already seeded.`);
    const connection: AppConnection = {
      identity,
      sockets: new Map(),
      connections: [],
      acks: [],
      unacked: new Set(),
      ackWaiters: new Set(),
      nextSocket: 0,
    };
    const api = createFakeSlackApi({
      store,
      identity,
      botToken,
      appToken,
      now,
      pageSize: options.pageSize,
      emitEvent: broadcastEvent,
      connectionUrl() {
        const ticket = crypto.randomUUID();
        tickets.set(ticket, connection);
        const socketUrl = new URL(`/socket?ticket=${ticket}`, server.url);
        socketUrl.protocol = "ws:";
        return socketUrl.href;
      },
    });
    apps.set(appToken, { connection, api });
    tokens.set(appToken, api);
    tokens.set(botToken, api);
    return {
      ...api.controls,
      url,
      botToken,
      appToken,
      identity,
      calls: api.calls,
      acks: connection.acks,
      connections: connection.connections,
      get activeConnections() {
        return connection.sockets.size;
      },
      envelope: (event: Record<string, unknown>, settings?: FakeEventOptions) =>
        envelope(identity, event, settings),
      sendEvent: (event: Record<string, unknown>, settings?: FakeEventOptions) =>
        sendEvent(connection, event, settings),
      disconnect() {
        sendFrame(connection, {
          type: "disconnect",
          reason: "refresh_requested",
          debug_info: { host: "fake-slack" },
        });
      },
      dropConnections() {
        for (const socket of connection.sockets.values()) socket.terminate();
      },
      setNextHelloAppId(appId: string) {
        connection.nextHelloAppId = appId;
      },
      waitForAck(envelopeId: string, timeoutMs = 1000): Promise<FakeSlackAck | null> {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
          throw new Error("Ack timeout must be nonnegative and finite.");
        const existing = connection.acks.findLast((ack) => ack.envelopeId === envelopeId);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve) => {
          const waiter = {
            envelopeId,
            finish(ack: FakeSlackAck | null) {
              clearTimeout(timer);
              connection.ackWaiters.delete(waiter);
              resolve(ack);
            },
          };
          const timer = setTimeout(() => waiter.finish(null), timeoutMs);
          connection.ackWaiters.add(waiter);
        });
      },
      failNext: api.failNext,
    };
  }

  return {
    ...primary,
    get activeConnections() {
      return primary.activeConnections;
    },
    addApp(settings: Partial<FakeSlackIdentity> = {}) {
      const number = apps.size + 1;
      return createApp(
        {
          ...identity,
          appId: `AFAKE${number}`,
          botId: `BFAKE${number}`,
          botUserId: `UFAKEBOT${number}`,
          ...settings,
        },
        `xoxb-fake-${number}-for-local-tests-only`,
        `xapp-fake-${number}-for-local-tests-only`,
      );
    },
    broadcastEvent,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      for (const { connection, api } of apps.values()) {
        for (const waiter of connection.ackWaiters) waiter.finish(null);
        api.finishPending();
        for (const socket of connection.sockets.values()) socket.terminate();
      }
      await server.stop(true);
      const allProblems = [...problems, ...[...apps.values()].flatMap(({ api }) => api.problems)];
      if (allProblems.length)
        throw new Error(`Unexpected fake Slack traffic:\n${allProblems.join("\n")}`);
    },
  };
}

// A wire fake, not a second bridge implementation.
// Socket tickets, hello, envelopes, acks and disconnects:
// https://docs.slack.dev/apis/events-api/using-socket-mode/
// Installation authorizations and globally unique event IDs:
// https://docs.slack.dev/apis/events-api/#callback-field

import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { createFakeSlackApi } from "./api";
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

type SocketData = { id: number };
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
  const botToken = "xoxb-fake-for-local-tests-only";
  const appToken = "xapp-fake-for-local-tests-only";
  const acks: FakeSlackAck[] = [];
  const connections: number[] = [];
  const unacked = new Set<string>();
  const problems: string[] = [];
  const tickets = new Set<string>();
  const sockets = new Map<number, ServerWebSocket<SocketData>>();
  const ackWaiters = new Set<{ envelopeId: string; finish(ack: FakeSlackAck | null): void }>();
  let nextHelloAppId: string | undefined;
  let connectionSequence = 0;
  let responsive = true;
  let stopped = false;
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: route,
    websocket: {
      sendPings: false,
      open(socket) {
        sockets.set(socket.data.id, socket);
        connections.push(socket.data.id);
        socket.send(
          JSON.stringify({
            type: "hello",
            connection_info: { app_id: nextHelloAppId ?? identity.appId },
            num_connections: sockets.size,
            debug_info: { host: "fake-slack", build_number: 1, approximate_connection_time: 3600 },
          }),
        );
        nextHelloAppId = undefined;
        if (!responsive) socket.pause();
      },
      message(_socket, bytes) {
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
        if (!unacked.delete(ack.data.envelope_id)) {
          problems.push(`Ack names an unknown or already acked envelope: ${ack.data.envelope_id}`);
          return;
        }
        const recorded = {
          envelopeId: ack.data.envelope_id,
          at: now(),
          body: ack.data,
        };
        acks.push(recorded);
        for (const waiter of ackWaiters) {
          if (waiter.envelopeId === recorded.envelopeId) waiter.finish(recorded);
        }
      },
      close(socket) {
        sockets.delete(socket.data.id);
      },
    },
  });
  const url = new URL("/api/", server.url).href;
  const api = createFakeSlackApi({
    identity,
    botToken,
    appToken,
    now,
    pageSize: options.pageSize,
    emitEvent(event, context) {
      if (sockets.size) sendEvent(event, { context });
    },
    connectionUrl() {
      const ticket = crypto.randomUUID();
      tickets.add(ticket);
      const socketUrl = new URL(`/socket?ticket=${ticket}`, server.url);
      socketUrl.protocol = "ws:";
      return socketUrl.href;
    },
  });
  const heartbeat = setInterval(() => {
    if (responsive) for (const socket of sockets.values()) socket.ping("fake-slack");
  }, 1000);

  async function route(request: Request): Promise<Response | undefined> {
    const target = new URL(request.url);
    if (target.pathname === "/socket") {
      const ticket = target.searchParams.get("ticket");
      if (!ticket || !tickets.delete(ticket))
        return new Response("Invalid ticket", { status: 403 });
      if (server.upgrade(request, { data: { id: ++connectionSequence } })) return;
      return new Response("WebSocket upgrade required", { status: 400 });
    }
    if (!target.pathname.startsWith("/api/")) {
      problems.push(`Unexpected Slack route: ${target.pathname}`);
      return new Response("Unknown fake Slack route", { status: 404 });
    }
    return api.handle(request);
  }

  function sendFrame(frame: Record<string, unknown>): FakeSlackDelivery {
    const socket = [...sockets.values()].at(-1);
    if (!socket) throw new Error("Fake Slack has no matching open socket.");
    const copy = structuredClone(frame);
    const envelopeId = typeof copy.envelope_id === "string" ? copy.envelope_id : "";
    if (envelopeId) unacked.add(envelopeId);
    socket.send(JSON.stringify(copy));
    return { envelopeId };
  }

  /** `event` framed as Slack sends it over Socket Mode. */
  function envelope(event: Record<string, unknown>, settings: FakeEventOptions = {}) {
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

  function sendEvent(event: Record<string, unknown>, settings?: FakeEventOptions) {
    return sendFrame(envelope(event, settings));
  }

  return {
    ...api.controls,
    url,
    botToken,
    appToken,
    identity,
    calls: api.calls,
    acks,
    connections,
    get activeConnections() {
      return sockets.size;
    },
    sendFrame,
    envelope,
    sendEvent,
    disconnect() {
      sendFrame({
        type: "disconnect",
        reason: "refresh_requested",
        debug_info: { host: "fake-slack" },
      });
    },
    dropConnections() {
      for (const socket of sockets.values()) socket.terminate();
    },
    setNextHelloAppId(appId: string) {
      nextHelloAppId = appId;
    },
    setSocketResponsive(value: boolean) {
      responsive = value;
      for (const socket of sockets.values()) {
        if (value) socket.resume();
        else socket.pause();
      }
    },
    waitForAck(envelopeId: string, timeoutMs = 1000): Promise<FakeSlackAck | null> {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
        throw new Error("Ack timeout must be nonnegative and finite.");
      const existing = acks.findLast((ack) => ack.envelopeId === envelopeId);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const waiter = {
          envelopeId,
          finish(ack: FakeSlackAck | null) {
            clearTimeout(timer);
            ackWaiters.delete(waiter);
            resolve(ack);
          },
        };
        const timer = setTimeout(() => waiter.finish(null), timeoutMs);
        ackWaiters.add(waiter);
      });
    },
    failNext: api.failNext,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      for (const waiter of ackWaiters) waiter.finish(null);
      api.finishPending();
      for (const socket of sockets.values()) socket.terminate();
      await server.stop(true);
      const allProblems = [...problems, ...api.problems];
      if (allProblems.length)
        throw new Error(`Unexpected fake Slack traffic:\n${allProblems.join("\n")}`);
    },
  };
}

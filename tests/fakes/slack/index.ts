// A wire fake, not a second bridge implementation.
// Socket tickets, hello, envelopes, acks and disconnects:
// https://docs.slack.dev/apis/events-api/using-socket-mode/
// Installation authorizations and globally unique event IDs:
// https://docs.slack.dev/apis/events-api/#callback-field
// Retry timing is driven explicitly by tests. Slack does not document a fixed Socket Mode
// redelivery schedule or promise whether an envelope ID changes between deliveries.

import type { ServerWebSocket } from "bun";
import { z } from "zod";

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
  connectionId: number;
  at: number;
  payload?: unknown;
  body: { envelope_id: string; payload?: unknown };
};

export type FakeSlackFailure = { error: string } | { retryAfter: number };

export type FakeSlackConnection = {
  id: number;
  openedAt: number;
  closedAt: number | null;
};

export type FakeSlackDelivery = {
  envelopeId: string;
  connectionId: number;
  sentAt: number;
  frame: Readonly<Record<string, unknown>>;
};

export type FakeEventOptions = {
  eventId?: string;
  envelopeId?: string;
  teamId?: string;
  appId?: string;
  /** Omit this option for our bot tuple; explicitly pass undefined to omit the wire field. */
  authorizations?: unknown;
  retryAttempt?: number;
  retryReason?: string;
  /** Additional outer callback fields, such as event_context or context_team_id. */
  context?: Record<string, unknown>;
};

export type FakeSlack = {
  readonly url: string;
  readonly botToken: string;
  readonly appToken: string;
  readonly identity: FakeSlackIdentity;
  readonly calls: readonly FakeSlackCall[];
  readonly acks: readonly FakeSlackAck[];
  readonly connections: readonly FakeSlackConnection[];
  readonly deliveries: readonly FakeSlackDelivery[];
  readonly activeConnections: number;
  sendEvent(event: Record<string, unknown>, options?: FakeEventOptions): FakeSlackDelivery;
  sendInteraction(payload: unknown, envelopeId?: string): FakeSlackDelivery;
  /** Also allows deliberately malformed/new payloads for receiver robustness tests. */
  sendFrame(frame: Record<string, unknown>, connectionId?: number): FakeSlackDelivery;
  /** Retries an unacked delivery, keeping its ID unless a new envelope ID is requested. */
  redeliver(envelopeId: string, newEnvelopeId?: string): FakeSlackDelivery;
  disconnect(reason?: "warning" | "refresh_requested" | "link_disabled"): void;
  dropConnections(): void;
  setNextHelloAppId(appId: string): void;
  setSocketResponsive(responsive: boolean): void;
  waitForAck(envelopeId: string, timeoutMs?: number): Promise<FakeSlackAck | null>;
  failNext(method: string, failure: FakeSlackFailure): void;
  /** Stops the server and fails if a client used an unknown method, argument or ack. */
  stop(): Promise<void>;
};

type SocketData = { id: number };
const ackSchema = z
  .object({ envelope_id: z.string().min(1), payload: z.unknown().optional() })
  .strict();

export function startFakeSlack(
  options: {
    now?: () => number;
    identity?: Partial<FakeSlackIdentity>;
    pingIntervalMs?: number;
  } = {},
): FakeSlack {
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
  const calls: FakeSlackCall[] = [];
  const acks: FakeSlackAck[] = [];
  const connections: FakeSlackConnection[] = [];
  const deliveries: FakeSlackDelivery[] = [];
  const problems: string[] = [];
  const tickets = new Set<string>();
  const sockets = new Map<number, ServerWebSocket<SocketData>>();
  const failures = new Map<string, FakeSlackFailure[]>();
  const ackWaiters = new Set<{ envelopeId: string; finish(ack: FakeSlackAck | null): void }>();
  let nextHelloAppId: string | undefined;
  let responsive = true;
  let stopped = false;
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: route,
    websocket: {
      open(socket) {
        sockets.set(socket.data.id, socket);
        connections.push({ id: socket.data.id, openedAt: now(), closedAt: null });
        socket.send(
          JSON.stringify({
            type: "hello",
            connection_info: { app_id: nextHelloAppId ?? identity.appId },
            num_connections: sockets.size,
            debug_info: { approximate_connection_time: 3600 },
          }),
        );
        nextHelloAppId = undefined;
        if (!responsive) socket.pause();
      },
      message(socket, bytes) {
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
        const sent = deliveries.filter(
          ({ envelopeId }) => envelopeId === ack.data.envelope_id,
        ).length;
        const received = acks.filter(
          ({ envelopeId }) => envelopeId === ack.data.envelope_id,
        ).length;
        if (!sent || received >= sent) {
          problems.push(`Ack names an unknown or already acked envelope: ${ack.data.envelope_id}`);
          return;
        }
        const recorded = {
          envelopeId: ack.data.envelope_id,
          connectionId: socket.data.id,
          at: now(),
          ...(Object.hasOwn(ack.data, "payload") ? { payload: ack.data.payload } : {}),
          body: ack.data,
        };
        acks.push(recorded);
        for (const waiter of ackWaiters) {
          if (waiter.envelopeId === recorded.envelopeId) waiter.finish(recorded);
        }
      },
      close(socket) {
        sockets.delete(socket.data.id);
        const connection = connections.find(({ id }) => id === socket.data.id);
        if (connection) connection.closedAt = now();
      },
    },
  });
  const url = new URL("/api/", server.url).href;
  const heartbeat = setInterval(() => {
    if (responsive) for (const socket of sockets.values()) socket.ping("fake-slack");
  }, options.pingIntervalMs ?? 1000);

  async function route(request: Request): Promise<Response | undefined> {
    const target = new URL(request.url);
    if (target.pathname === "/socket") {
      const ticket = target.searchParams.get("ticket");
      if (!ticket || !tickets.delete(ticket))
        return new Response("Invalid ticket", { status: 403 });
      if (server.upgrade(request, { data: { id: connections.length + 1 } })) return;
      return new Response("WebSocket upgrade required", { status: 400 });
    }
    if (!target.pathname.startsWith("/api/")) {
      problems.push(`Unexpected Slack route: ${target.pathname}`);
      return new Response("Unknown fake Slack route", { status: 404 });
    }
    const method = target.pathname.slice("/api/".length);
    const contentType = request.headers.get("content-type") ?? "";
    let args: Record<string, unknown>;
    if (request.method === "GET") {
      args = Object.fromEntries(target.searchParams);
    } else if (
      request.method === "POST" &&
      contentType.startsWith("application/x-www-form-urlencoded")
    ) {
      args = Object.fromEntries(new URLSearchParams(await request.text()));
    } else if (request.method === "POST" && contentType.startsWith("application/json")) {
      const parsed = z.record(z.string(), z.unknown()).safeParse(await request.json());
      if (!parsed.success) return unexpected(`${method} body is not an object.`);
      args = parsed.data;
    } else {
      return unexpected(`${method} used unexpected HTTP method/content type.`);
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    calls.push({ method, args, token, at: now() });
    if (method !== "apps.connections.open")
      return unexpected(`Unknown fake Slack method: ${method}`);
    const parsed = z.object({}).strict().safeParse(args);
    if (!parsed.success) return unexpected(`${method}: ${parsed.error.message}`);
    if (token !== appToken)
      return Response.json({ ok: false, error: token ? "invalid_auth" : "not_authed" });
    const failure = failures.get(method)?.shift();
    if (failure) {
      if ("retryAfter" in failure)
        return Response.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "Retry-After": String(failure.retryAfter) } },
        );
      return Response.json({ ok: false, error: failure.error });
    }
    const ticket = crypto.randomUUID();
    tickets.add(ticket);
    const socketUrl = new URL(`/socket?ticket=${ticket}`, server.url);
    socketUrl.protocol = "ws:";
    return Response.json({ ok: true, url: socketUrl.href });
  }

  function unexpected(message: string): Response {
    problems.push(message);
    return Response.json({
      ok: false,
      error: "invalid_arguments",
      response_metadata: { messages: [message] },
    });
  }

  function sendFrame(frame: Record<string, unknown>, connectionId?: number): FakeSlackDelivery {
    const socket =
      connectionId === undefined ? [...sockets.values()].at(-1) : sockets.get(connectionId);
    if (!socket) throw new Error("Fake Slack has no matching open socket.");
    const copy = structuredClone(frame);
    const envelopeId = typeof copy.envelope_id === "string" ? copy.envelope_id : "";
    const delivery = { envelopeId, connectionId: socket.data.id, sentAt: now(), frame: copy };
    deliveries.push(delivery);
    socket.send(JSON.stringify(copy));
    return delivery;
  }

  return {
    url,
    botToken,
    appToken,
    identity,
    calls,
    acks,
    connections,
    deliveries,
    get activeConnections() {
      return sockets.size;
    },
    sendFrame,
    sendEvent(event, settings = {}) {
      const payload: Record<string, unknown> = {
        ...settings.context,
        type: "event_callback",
        api_app_id: settings.appId ?? identity.appId,
        team_id: settings.teamId ?? identity.teamId,
        event_id: settings.eventId ?? `Ev${crypto.randomUUID()}`,
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
      return sendFrame({
        type: "events_api",
        envelope_id: settings.envelopeId ?? crypto.randomUUID(),
        accepts_response_payload: false,
        retry_attempt: settings.retryAttempt ?? 0,
        ...(settings.retryReason === undefined ? {} : { retry_reason: settings.retryReason }),
        payload,
      });
    },
    sendInteraction(payload, envelopeId = crypto.randomUUID()) {
      return sendFrame({
        type: "interactive",
        envelope_id: envelopeId,
        accepts_response_payload: true,
        payload: structuredClone(payload),
      });
    },
    redeliver(envelopeId, newEnvelopeId = envelopeId) {
      const previous = deliveries.findLast((delivery) => delivery.envelopeId === envelopeId);
      if (!previous) throw new Error(`Unknown envelope ${envelopeId}.`);
      if (acks.some((ack) => ack.envelopeId === envelopeId))
        throw new Error(`Envelope ${envelopeId} is already acked.`);
      const attempt = previous.frame.retry_attempt;
      return sendFrame({
        ...previous.frame,
        envelope_id: newEnvelopeId,
        retry_attempt: (typeof attempt === "number" ? attempt : 0) + 1,
        retry_reason: "timeout",
      });
    },
    disconnect(reason = "refresh_requested") {
      sendFrame({ type: "disconnect", reason, debug_info: { host: "fake-slack" } });
    },
    dropConnections() {
      for (const socket of sockets.values()) socket.terminate();
    },
    setNextHelloAppId(appId) {
      nextHelloAppId = appId;
    },
    setSocketResponsive(value) {
      responsive = value;
      for (const socket of sockets.values()) {
        if (value) socket.resume();
        else socket.pause();
      }
    },
    waitForAck(envelopeId, timeoutMs = 1000) {
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
    failNext(method, failure) {
      const queue = failures.get(method) ?? [];
      queue.push(failure);
      failures.set(method, queue);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      for (const waiter of ackWaiters) waiter.finish(null);
      for (const socket of sockets.values()) socket.terminate();
      await server.stop(true);
      if (problems.length)
        throw new Error(`Unexpected fake Slack traffic:\n${problems.join("\n")}`);
    },
  };
}

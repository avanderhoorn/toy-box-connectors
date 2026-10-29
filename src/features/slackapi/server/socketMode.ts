import {
  LogLevel,
  SocketModeClient,
  type Logger,
  type SocketModeOptions,
} from "@slack/socket-mode";
import { readFrame, type SocketFrame } from "../model/envelopes";
import { oneAttemptOptions, readCallFailure, type CallFailure } from "./botClient";

export type SocketOpening =
  | { kind: "open" | "closed" }
  | { kind: "failed"; failure: CallFailure }
  | { kind: "dropped"; detail: string };
export type SlackSocket = {
  opened: Promise<SocketOpening>;
  closed: Promise<void>;
  ack(envelopeId: string): void;
  close(): void;
};
export type SlackSocketOptions = {
  onFrame: (frame: SocketFrame, arrivedAt: number) => void;
  slackApiUrl?: string;
  helloTimeoutMs?: number;
  pingTimeoutMs?: number;
  now?: () => number;
};

/** Reconnects belong to the supervisor. Raw dispatch preserves app_rate_limited frames. */
export function openSlackSocket(
  appToken: string,
  {
    onFrame,
    slackApiUrl,
    helloTimeoutMs = 30_000,
    pingTimeoutMs,
    now = () => Date.now(),
  }: SlackSocketOptions,
): SlackSocket {
  const opened = Promise.withResolvers<SocketOpening>();
  const closed = Promise.withResolvers<void>();
  let closing = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (result: SocketOpening) => {
    clearTimeout(helloTimer);
    opened.resolve(result);
  };
  const client = new FrameClient(
    {
      appToken,
      autoReconnectEnabled: false,
      clientPingTimeout: pingTimeoutMs,
      logger: silentLogger,
      clientOptions: oneAttemptOptions({ slackApiUrl }),
    },
    (raw) => {
      if (closing) return;
      const frame = readFrame(raw);
      if (frame.kind === "hello") settle({ kind: "open" });
      onFrame(frame, now());
      if (frame.kind === "disconnect") close();
    },
  );
  client.on("connecting", () => {
    if (closing) queueMicrotask(() => terminate(client));
    else
      helloTimer = setTimeout(() => {
        settle({ kind: "dropped", detail: "Slack didn't say hello in time" });
        close();
      }, helloTimeoutMs);
  });
  // Raw dispatch bypasses the SDK's hello handler, so start settles only when the connection ends.
  client.start().catch((error: unknown) => {
    settle(
      error === undefined
        ? { kind: "dropped", detail: "The connection closed before Slack said hello" }
        : {
            kind: "failed",
            failure: readCallFailure(error) ?? {
              kind: "unknown",
              detail:
                error instanceof Error ? error.message : "Unrecognized Slack connection failure",
            },
          },
    );
    closed.resolve();
  });
  function close() {
    if (closing) return;
    closing = true;
    settle({ kind: "closed" });
    if (client.websocket) terminate(client);
  }
  return {
    opened: opened.promise,
    closed: closed.promise,
    close,
    ack(envelopeId) {
      client.websocket?.send(JSON.stringify({ envelope_id: envelopeId }), () => {});
    },
  };
}

class FrameClient extends SocketModeClient {
  constructor(
    options: SocketModeOptions,
    private readonly take: (raw: string) => void,
  ) {
    super(options);
  }
  protected override onWebSocketMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") this.take(data);
    return Promise.resolve();
  }
}

function terminate(client: SocketModeClient) {
  const socket = client.websocket;
  socket?.disconnect();
  if (socket?.readyState === WebSocket.CLOSING) socket.disconnect();
}

// The SDK's normal logger includes payloads.
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  setName() {},
  getLevel: () => LogLevel.ERROR,
};

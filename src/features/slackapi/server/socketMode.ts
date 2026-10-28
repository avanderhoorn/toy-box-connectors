import {
  LogLevel,
  SocketModeClient,
  type Logger,
  type SocketModeOptions,
} from "@slack/socket-mode";
import { readFrame, type SocketFrame } from "@slackapi/model/envelopes";
import { oneAttemptOptions, readCallFailure, type CallFailure } from "@slackapi/server/botClient";

// One Socket Mode connection.
//
// The SDK's client reconnects on its own and parses each frame before anything else sees it,
// throwing on payloads the bridge must still handle. So each connection here is one client with
// reconnecting off whose raw frames go straight to the caller, and the caller decides when to open
// the next one. A connection is open once Slack says hello. Closing never waits on Slack, so a
// connection the bridge closes is gone at once, and an envelope it didn't ack comes again on the
// next one.

/** How opening a connection ended. */
export type SocketOpening =
  /** Slack said hello. */
  | { kind: "open" }
  /** The bridge closed the connection first. */
  | { kind: "closed" }
  /** apps.connections.open failed. */
  | { kind: "failed"; failure: CallFailure }
  /** The connection ended before Slack said hello, for the reason `detail` gives. */
  | { kind: "dropped"; detail: string };

export type SlackSocket = {
  /** Settles once Slack says hello, the connection fails, or the bridge closes it. */
  opened: Promise<SocketOpening>;
  /** Resolves with when the connection ended, once it has. */
  closed: Promise<number>;
  /** Acks an envelope. Once the connection is gone, Slack sends the envelope again instead. */
  ack(envelopeId: string): void;
  /** Ends the connection at once. No frame reaches `onFrame` afterwards. */
  close(): void;
};

export type SlackSocketOptions = {
  /** Called with every frame as it arrives, and when it arrived. */
  onFrame: (frame: SocketFrame, arrivedAt: number) => void;
  slackApiUrl?: string;
  timeoutMs?: number;
  /** How long Slack has to say hello once the connection starts. */
  helloTimeoutMs?: number;
  /** How long Slack has to answer pings before the connection counts as lost. */
  pingTimeoutMs?: number;
  now?: () => number;
};

/** Opens a Socket Mode connection with the app-level token. */
export function openSlackSocket(
  appToken: string,
  {
    onFrame,
    slackApiUrl,
    timeoutMs,
    helloTimeoutMs = 30_000,
    pingTimeoutMs,
    now = Date.now,
  }: SlackSocketOptions,
): SlackSocket {
  const opened = Promise.withResolvers<SocketOpening>();
  const closed = Promise.withResolvers<number>();
  let closing = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;

  const client = new FrameClient(
    {
      appToken,
      autoReconnectEnabled: false,
      clientPingTimeout: pingTimeoutMs,
      logger: silentLogger,
      clientOptions: oneAttemptOptions({ slackApiUrl, timeoutMs }),
    },
    (raw) => {
      if (closing) return;
      const arrivedAt = now();
      const frame = readFrame(raw);
      if (frame.kind === "hello") settle({ kind: "open" });
      onFrame(frame, arrivedAt);
      // Slack is about to drop the connection, so the next one can start now.
      if (frame.kind === "disconnect") close();
    },
  );
  client.on("connecting", () => {
    // The connection starts right after this, so one closed meanwhile ends once it has.
    if (closing) queueMicrotask(() => terminate(client));
    else helloTimer = setTimeout(timedOut, helloTimeoutMs);
  });
  // start() never resolves, since only the SDK's own frame handling announces hello. It rejects
  // with apps.connections.open's error, or with nothing once the connection closes.
  client.start().catch((error: unknown) => {
    settle(
      error === undefined
        ? { kind: "dropped", detail: "the connection closed before Slack said hello" }
        : { kind: "failed", failure: readCallFailure(error) ?? unreadable(error) },
    );
    closed.resolve(now());
  });

  function settle(opening: SocketOpening) {
    clearTimeout(helloTimer);
    opened.resolve(opening);
  }

  function timedOut() {
    settle({ kind: "dropped", detail: "Slack didn't say hello in time" });
    close();
  }

  function close() {
    if (closing) return;
    closing = true;
    settle({ kind: "closed" });
    if (client.websocket) terminate(client);
  }

  return {
    opened: opened.promise,
    closed: closed.promise,
    ack(envelopeId) {
      // The SDK's send ignores a connection that's closing or gone, and catches one still starting.
      client.websocket?.send(JSON.stringify({ envelope_id: envelopeId }), () => {});
    },
    close,
  };
}

/** A client that hands every text frame to `take` and acts on none of them itself. */
class FrameClient extends SocketModeClient {
  readonly #take: (raw: string) => void;

  constructor(options: SocketModeOptions, take: (raw: string) => void) {
    super(options);
    this.#take = take;
  }

  // Slack sends only text frames, and undici may deliver several before a promise could settle, so
  // each is taken synchronously.
  protected override onWebSocketMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") this.#take(data);
    return Promise.resolve();
  }
}

/**
 * Ends a client's connection without waiting on Slack. The first disconnect starts the close
 * handshake, and a second while it's pending tears the connection down and reports it closed.
 */
function terminate(client: SocketModeClient) {
  const { websocket } = client;
  websocket?.disconnect();
  if (websocket?.readyState === WebSocket.CLOSING) websocket.disconnect();
}

function unreadable(error: unknown): CallFailure {
  return { kind: "unknown", detail: error instanceof Error ? error.message : String(error) };
}

/** The SDK logs payloads, so it logs nothing, and the bridge logs what it decides. */
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  getLevel: () => LogLevel.ERROR,
  setName() {},
};

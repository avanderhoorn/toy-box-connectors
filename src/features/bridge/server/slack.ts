import { startSlackReceiver } from "@activity/server/receiver";
import type { SlackState } from "@commands/model/status";
import {
  helloRefusal,
  refusalProblem,
  rejectedTokenProblem,
  type IdentityRefusal,
  type TokenName,
} from "@slackapi/model/identity";
import type { BotClient, CallFailure } from "@slackapi/server/botClient";
import { openSlackSocket, type SlackSocket } from "@slackapi/server/socketMode";
import { defaultWakeTimings, retryDelay, type WakeTimings } from "@wakes/model";
import { sleep } from "@/shared/sleep";
import type { BridgeDatabase } from "./database";
import { confirmIdentity } from "./identity";

// The Slack connection.
//
// The bridge confirms whose tokens it holds once, before it takes anything from Slack, and asks
// again only while Slack can't answer. Then it keeps one Socket Mode connection open. Each
// connection starts from a fresh apps.connections.open, and its frames reach the receiver only
// once hello names the installation's app. Losing a connection and each hello are noted in order
// with the deliveries between them. A connection that never opened, or dropped within a minute of
// its hello, backs off, so a Slack that keeps refusing or dropping it costs a call every few
// minutes rather than a reconnect a second. A refusal, or a token Slack rejects, lasts until the
// operator fixes it and restarts the bridge. A rejected bot token leaves the connection up, so
// deletions and a channel's lifecycle are still taken.

export interface SlackSupervisor {
  /** How the connection is doing, and what to do about it when something's wrong. */
  state(): SlackState;
  /** The workspace's address as Slack confirmed it, or null before it has. */
  workspaceUrl(): string | null;
  /** Notes that a call found Slack rejecting the bot token, which status shows until a restart. */
  botRejected(error: string): void;
  /**
   * Closes the connection, and stops once the delivery in hand is handled and the call to Slack in
   * flight has ended, which its timeout bounds.
   */
  stop(): Promise<void>;
}

export type SlackSupervisorOptions = {
  tokens: { botToken: string; appToken: string };
  slackApiUrl?: string;
  /** Called after a delivery changed a link or request. */
  onChange?: () => void;
  /** Called when the supervisor stops on an error that retrying can't fix, such as storage failing. */
  onError?: (error: unknown) => void;
  now?: () => number;
  /** Asking Slack about the tokens, and a connection that didn't last, retry on the wake retry backoff. */
  timings?: WakeTimings;
  /** How long a connection that lasted waits to reconnect. */
  reconnectDelay?: number;
  helloTimeoutMs?: number;
  pingTimeoutMs?: number;
};

/** How long a connection must last after its hello for losing it to reconnect without backing off. */
export const STEADY_CONNECTION_MS = 60_000;

/** How one connection ended, which decides how long to wait before the next, or null for none. */
type Ended = { steady: boolean; retryAfterMs?: number } | null;

/** Confirms the tokens and keeps Slack connected, until it's stopped or Slack is refused. */
export function startSlackSupervisor(
  database: BridgeDatabase,
  bot: BotClient,
  {
    tokens,
    slackApiUrl,
    onChange,
    onError = () => {},
    now = Date.now,
    timings = defaultWakeTimings,
    reconnectDelay = 1_000,
    helloTimeoutMs,
    pingTimeoutMs,
  }: SlackSupervisorOptions,
): SlackSupervisor {
  const stopping = new AbortController();
  const { signal } = stopping;
  const receiver = startSlackReceiver(database, {
    onChange,
    onUninstalled: () => refuse({ reason: "uninstalled" }),
    onError: halt,
    now,
  });
  let socket: SlackSocket | undefined;
  let workspace: string | null = null;
  let refusal: IdentityRefusal | null = null;
  // What status says about each token Slack rejected.
  const rejected = new Map<TokenName, string>();
  // Why Slack isn't connected while the bridge keeps trying.
  let problem: string | null = null;
  let connected = false;
  let everConnected = false;
  let failed = false;

  // The bridge may have missed anything since it last ran.
  receiver.disconnected(now()).catch(fail);
  const running = run().catch(fail);

  async function run() {
    const appId = await confirm();
    let failures = 0;
    while (appId !== null && !signal.aborted) {
      const ended = await connectOnce(appId);
      if (ended === null) return;
      failures = ended.steady ? 0 : failures + 1;
      const backoff = Math.max(retryDelay(failures, timings), ended.retryAfterMs ?? 0);
      await sleep(failures === 0 ? reconnectDelay : backoff, signal);
    }
  }

  /** Asks Slack whose tokens these are until it answers, and returns their app if it may connect. */
  async function confirm(): Promise<string | null> {
    for (let failures = 1; !signal.aborted; failures++) {
      const verdict = await confirmIdentity(database, bot, tokens);
      if (signal.aborted) return null;
      switch (verdict.kind) {
        case "confirmed":
          workspace = verdict.workspaceUrl;
          problem = null;
          return verdict.installation.appId;
        case "refused":
          refuse(verdict.refusal);
          return null;
        case "auth_failed":
          return reject("SLACK_BOT_TOKEN", verdict.error);
        case "unavailable": {
          trouble(`${verdict.detail}.`);
          const askedWait = (verdict.retryAt ?? 0) - now();
          await sleep(Math.max(retryDelay(failures, timings), askedWait), signal);
        }
      }
    }
    return null;
  }

  /** Connects once and waits for the connection to end. */
  async function connectOnce(appId: string): Promise<Ended> {
    let hello: Promise<void> | undefined;
    let helloAt = 0;
    let reason: string | null = null;
    const current = openSlackSocket(tokens.appToken, {
      slackApiUrl,
      helloTimeoutMs,
      pingTimeoutMs,
      now,
      onFrame(frame, arrivedAt) {
        switch (frame.kind) {
          case "hello": {
            const refused = helloRefusal(appId, frame.appId);
            if (refused !== null) return refuse(refused);
            helloAt = arrivedAt;
            hello = receiver.connected(arrivedAt);
            return;
          }
          case "disconnect":
            reason = frame.reason;
            return;
          default:
            // Slack says hello first, so a frame before it is left for Slack to send again.
            if (hello === undefined) return;
            receiver.receive(frame, arrivedAt, (envelopeId) => current.ack(envelopeId)).catch(fail);
        }
      },
    });
    socket = current;
    const opening = await current.opened;
    if (opening.kind !== "open") {
      await current.closed;
      if (opening.kind === "failed") return openFailed(opening.failure);
      return opening.kind === "dropped" ? trouble(`${opening.detail}.`) : null;
    }

    // The hello's note commits before anything the connection delivers.
    await hello;
    if (!signal.aborted) {
      console.error("Connected to Slack.");
      connected = true;
      everConnected = true;
      problem = null;
    }
    const closedAt = await current.closed;
    connected = false;
    // Stopping, failing or refusing Slack notes nothing, since only starting again reconnects, and
    // starting notes that the bridge may have missed anything.
    if (signal.aborted) return null;
    receiver.disconnected(closedAt).catch(fail);
    console.error(`${connectionLoss(reason)}, so the bridge is reconnecting.`);
    return { steady: closedAt - helloAt >= STEADY_CONNECTION_MS };
  }

  function openFailed(failure: CallFailure): Ended {
    switch (failure.kind) {
      case "auth_failed":
        return reject("SLACK_APP_TOKEN", failure.error);
      case "error":
        if (appTokenErrors.has(failure.error)) return reject("SLACK_APP_TOKEN", failure.error);
        return trouble(`Slack refused apps.connections.open with ${failure.error}.`);
      case "rate_limited":
        return trouble(
          "Slack is holding back apps.connections.open.",
          failure.retryAfterSeconds * 1_000,
        );
      case "unknown":
        return trouble(`Slack didn't answer apps.connections.open: ${failure.detail}.`);
    }
  }

  // Only the operator can replace a token Slack rejected, so nothing asks about it again.
  function reject(token: TokenName, error: string): null {
    if (!signal.aborted && !rejected.has(token)) {
      const rejection = rejectedTokenProblem(token, error);
      rejected.set(token, rejection);
      console.error(rejection);
    }
    return null;
  }

  function trouble(found: string, retryAfterMs?: number): Ended {
    if (problem !== found) console.error(`Can't connect to Slack. ${found}`);
    problem = found;
    return { steady: false, retryAfterMs };
  }

  // Once the supervisor stops, fails or refuses, it reports nothing more.
  function refuse(found: IdentityRefusal) {
    if (signal.aborted) return;
    refusal = found;
    stopping.abort();
    socket?.close();
    console.error(refusalProblem(found));
  }

  function fail(error: unknown) {
    if (!failed) console.error("Stopped connecting to Slack:", error);
    halt(error);
  }

  // The receiver reports its own failures before they reach here.
  function halt(error: unknown) {
    if (failed) return;
    failed = true;
    stopping.abort();
    socket?.close();
    onError(error);
  }

  function state(): SlackState {
    if (refusal !== null) return { connection: "refused", problem: refusalProblem(refusal) };
    if (rejected.size > 0) {
      return { connection: "auth_failed", problem: [...rejected.values()].join(" ") };
    }
    if (connected) return { connection: "connected", problem: null };
    return { connection: everConnected ? "reconnecting" : "connecting", problem };
  }

  return {
    state,
    workspaceUrl: () => workspace,
    botRejected(error) {
      reject("SLACK_BOT_TOKEN", error);
    },
    async stop() {
      stopping.abort();
      socket?.close();
      await running;
      await receiver.stop();
    },
  };
}

/** Who ended a connection, and why when Slack said. */
function connectionLoss(reason: string | null): string {
  return reason === null
    ? "Lost the connection to Slack"
    : `Slack ended the connection with ${reason}`;
}

// Besides an auth failure, apps.connections.open refuses a token that isn't an app-level token or
// lacks connections:write. https://docs.slack.dev/reference/methods/apps.connections.open/#errors
const appTokenErrors: ReadonlySet<string> = new Set(["not_allowed_token_type", "missing_scope"]);

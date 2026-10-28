import { startSlackReceiver } from "@activity/server/receiver";
import type { SlackState } from "@commands/model/status";
import {
  helloRefusal,
  refusalProblem,
  rejectedTokenProblem,
  type IdentityRefusal,
} from "@slackapi/model/identity";
import type { BotClient, CallFailure } from "@slackapi/server/botClient";
import { openSlackSocket, type SlackSocket } from "@slackapi/server/socketMode";
import { defaultWakeTimings, retryDelay, type WakeTimings } from "@wakes/model";
import { sleep } from "@/shared/sleep";
import type { BridgeDatabase } from "./database";
import { confirmIdentity } from "./identity";

// The Slack connection.
//
// The bridge confirms whose tokens it holds before it takes anything from Slack, and then keeps one
// Socket Mode connection open. Each connection starts from a fresh apps.connections.open, and its
// frames reach the receiver only once hello names the installation's app. Losing a connection
// holds every pending request's replies at once, and the next hello records what may have been
// missed. A connection that never opened, or dropped within a minute of its hello, backs off, so
// a Slack that keeps refusing or dropping it costs a call every few minutes rather than a gap a
// second. While Slack rejects a token the bridge keeps asking, and the connection stays up
// meanwhile so deletions and a channel's lifecycle are still taken. A refusal turns Slack off
// until the operator acts.

export interface SlackSupervisor {
  /** How the connection is doing, and what to do about it when something's wrong. */
  state(): SlackState;
  /** The workspace's address as Slack last confirmed it, or null before it has. */
  workspaceUrl(): string | null;
  /** Asks Slack about the tokens again, because a call found Slack rejecting the bot token. */
  botRejected(error: string): void;
  /**
   * Closes the connection, and stops once the delivery in hand is handled and the call to Slack in
   * flight has ended, which its timeout bounds.
   */
  stop(): Promise<void>;
}

export type SlackSupervisorOptions = {
  tokens: { botToken: string; appToken: string };
  /** The folder local copies of files are kept in. */
  filesFolder: string;
  slackApiUrl?: string;
  /** Called when the connection's state changes, and after a delivery changed what's stored. */
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

/** How one connection ended, which decides how long to wait before the next. */
type Ended = { steady: boolean; retryAfterMs?: number };

/** Starts confirming the tokens and connecting, until it's stopped or Slack is refused. */
export function startSlackSupervisor(
  database: BridgeDatabase,
  bot: BotClient,
  {
    tokens,
    filesFolder,
    slackApiUrl,
    onChange = () => {},
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
    filesFolder,
    onChange,
    onUninstalled: () => refuse({ reason: "uninstalled" }),
    onError: halt,
    now,
  });
  let socket: SlackSocket | undefined;
  let workspace: string | null = null;
  let refusal: IdentityRefusal | null = null;
  let botRejection: string | null = null;
  let appRejection: string | null = null;
  // Why Slack isn't connected: the tokens can't be confirmed yet, or the last connection failed.
  let unconfirmed: string | null = null;
  let trouble: string | null = null;
  let connected = false;
  let everConnected = false;
  // Whether the bridge said something was wrong since it last connected, so connecting says so too.
  let failing = false;
  let recheck = false;
  let checking: Promise<void> | undefined;
  let connecting: Promise<void> | undefined;
  let failed = false;

  // The bridge may have missed anything since it last ran.
  receiver.disconnected(now()).catch(fail);
  check();

  function check() {
    recheck = true;
    checking ??= confirmWhileAsked();
  }

  // Asking again while an answer is on its way earns one more answer, however often it was asked.
  async function confirmWhileAsked() {
    let failures = 0;
    try {
      while (recheck && !signal.aborted) {
        recheck = false;
        const verdict = await confirmIdentity(database, bot, tokens, now);
        if (signal.aborted) return;
        switch (verdict.kind) {
          case "confirmed": {
            workspace = verdict.workspaceUrl;
            unconfirmed = null;
            failures = 0;
            // A rejection while Slack was asked may be newer than this answer, so it asks again.
            if (!recheck && botRejection !== null) {
              botRejection = null;
              console.error("Slack accepts SLACK_BOT_TOKEN again.");
            }
            connecting ??= connectWhileRunning(verdict.installation.appId);
            onChange();
            break;
          }
          case "refused":
            refuse(verdict.refusal);
            return;
          case "auth_failed":
            rejectBot(verdict.error);
            recheck = true;
            await sleep(retryDelay(++failures, timings), signal);
            break;
          case "unavailable": {
            const detail = `${verdict.detail}.`;
            if (unconfirmed !== detail) {
              console.error(`Can't confirm the Slack tokens yet. ${detail}`);
              failing = true;
            }
            unconfirmed = detail;
            recheck = true;
            const askedWait = (verdict.retryAt ?? 0) - now();
            await sleep(Math.max(retryDelay(++failures, timings), askedWait), signal);
          }
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      checking = undefined;
    }
  }

  function rejectBot(error: string) {
    const first = botRejection === null;
    botRejection = error;
    if (!first) return;
    console.error(rejectedTokenProblem("SLACK_BOT_TOKEN", error));
    failing = true;
    onChange();
  }

  async function connectWhileRunning(appId: string) {
    let failures = 0;
    try {
      while (!signal.aborted) {
        const ended = await connectOnce(appId);
        if (ended === null) return;
        failures = ended.steady ? 0 : failures + 1;
        const wait =
          failures === 0
            ? reconnectDelay
            : Math.max(retryDelay(failures, timings), ended.retryAfterMs ?? 0);
        await sleep(wait, signal);
      }
    } catch (error) {
      fail(error);
    }
  }

  /** Connects once and waits for the connection to end, or returns null when nothing follows it. */
  async function connectOnce(appId: string): Promise<Ended | null> {
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
            if (refused === null) {
              helloAt = arrivedAt;
              hello = receiver.connected(arrivedAt);
            } else refuse(refused);
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
      switch (opening.kind) {
        case "failed":
          return openFailed(opening.failure);
        case "dropped":
          appRejection = null;
          return troubled(`${opening.detail}.`);
        default:
          return null;
      }
    }

    // The gap this hello records commits before anything the connection delivers.
    await hello;
    if (!signal.aborted) {
      if (failing) console.error("Connected to Slack.");
      failing = false;
      connected = true;
      everConnected = true;
      trouble = null;
      appRejection = null;
      onChange();
    }
    const closedAt = await current.closed;
    connected = false;
    // Stopping, failing or refusing Slack records nothing, since only starting again reconnects, and
    // starting holds every reply until it hears from Slack.
    if (signal.aborted) return null;
    receiver.disconnected(closedAt).catch(fail);
    console.error(`${connectionLoss(reason)}, so the bridge is reconnecting.`);
    failing = true;
    onChange();
    return { steady: closedAt - helloAt >= STEADY_CONNECTION_MS };
  }

  function openFailed(failure: CallFailure): Ended {
    switch (failure.kind) {
      case "auth_failed":
        return rejectApp(failure.error);
      case "error":
        if (appTokenErrors.has(failure.error)) return rejectApp(failure.error);
        return troubled(`Slack refused apps.connections.open with ${failure.error}.`);
      case "rate_limited":
        return troubled(
          "Slack is holding back apps.connections.open.",
          failure.retryAfterSeconds * 1_000,
        );
      case "unknown":
        return troubled(`Slack didn't answer apps.connections.open: ${failure.detail}.`);
    }
  }

  function rejectApp(error: string): Ended {
    const first = appRejection === null;
    appRejection = error;
    if (first) {
      console.error(rejectedTokenProblem("SLACK_APP_TOKEN", error));
      failing = true;
      onChange();
    }
    return { steady: false };
  }

  function troubled(problem: string, retryAfterMs?: number): Ended {
    if (trouble !== problem) {
      console.error(`Can't connect to Slack. ${problem}`);
      failing = true;
    }
    trouble = problem;
    return { steady: false, retryAfterMs };
  }

  // Once the supervisor stops, fails or refuses, it reports nothing more.
  function refuse(found: IdentityRefusal) {
    if (signal.aborted) return;
    refusal = found;
    stopping.abort();
    socket?.close();
    console.error(refusalProblem(found));
    onChange();
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
    const rejected = [
      ...(botRejection === null ? [] : [rejectedTokenProblem("SLACK_BOT_TOKEN", botRejection)]),
      ...(appRejection === null ? [] : [rejectedTokenProblem("SLACK_APP_TOKEN", appRejection)]),
    ];
    if (rejected.length > 0) return { connection: "auth_failed", problem: rejected.join(" ") };
    if (connected) return { connection: "connected", problem: null };
    return {
      connection: everConnected ? "reconnecting" : "connecting",
      problem: trouble ?? unconfirmed,
    };
  }

  return {
    state,
    workspaceUrl: () => workspace,
    botRejected(error) {
      if (signal.aborted) return;
      rejectBot(error);
      check();
    },
    async stop() {
      stopping.abort();
      socket?.close();
      await checking;
      await connecting;
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

import type { BridgeDatabase } from "@bridge/server/database";
import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type WebAPICallResult,
  type WebClientOptions,
} from "@slack/web-api";
import { isAuthFailure, isErrorCode, isRateLimit } from "@slackapi/model/errors";
import { markAuthFailed } from "./installation";

// The bot's Web API client.
//
// Every call the bridge makes with the bot token goes through one client, so a rate limit holds that
// method back for every caller until the time Slack named, while other methods keep moving. The SDK
// makes one attempt per call: its retries would resend a post whose response was lost, and its own
// rate limit handling would stall every method behind one. A call that gets no answer, or an answer
// that isn't Slack's, may still have taken effect, so it's reported as unknown, and its caller
// decides what happens next.

/** How long a call may take before its outcome is unknown. */
export const slackCallTimeoutMs = 10_000;

/** How long a method waits when Slack limits it without a Retry-After the SDK can read. */
const defaultRetryAfterSeconds = 60;

// 8.2.0 throws a 429 without a Retry-After it can read as a plain Error that starts like this.
const unreadableRetryAfter = "Retry header did not contain a valid timeout";

/** What became of one call. */
export type SlackCall<Result> =
  | { kind: "ok"; result: Result }
  /** The caller's guard stopped the SDK call locally. Nothing was sent. */
  | { kind: "unusable" }
  /** Slack asked the bridge to wait until `until` before calling this method again. Nothing was sent. */
  | { kind: "rate_limited"; until: number }
  /** Slack rejected the bot token, and the installation is now auth_failed. */
  | { kind: "auth_failed"; error: string }
  /** Slack refused the call with an error code. */
  | { kind: "error"; error: string; data: WebAPICallResult }
  /**
   * No answer came back, from a timeout, a lost connection or an HTTP error, or the answer wasn't
   * Slack's, so the call may have taken effect.
   */
  | { kind: "unknown"; detail: string };

export type BotClient = {
  /**
   * Makes one call to `method` through `run`, unless Slack asked the bridge to wait. `run` makes
   * exactly that call, since `method` names the cooldown it waits on. Never call this inside a
   * database write, which would wait on it.
   */
  call<Result>(
    method: string,
    run: (client: WebClient) => Promise<Result>,
  ): Promise<SlackCall<Result>>;
  /** When `method` may next be called, or null when it may be called now. */
  cooldown(method: string): Promise<number | null>;
};

export type BotClientOptions = {
  slackApiUrl?: string;
  timeoutMs?: number;
  /**
   * Called with Slack's error after a call finds Slack rejecting the token and puts an active
   * installation in auth_failed.
   */
  onAuthFailed?: (error: string) => void;
  now?: () => number;
};

/** Creates the client every caller shares for the bot token. */
export function createBotClient(
  database: BridgeDatabase,
  token: string,
  {
    slackApiUrl,
    timeoutMs = slackCallTimeoutMs,
    onAuthFailed = () => {},
    now = Date.now,
  }: BotClientOptions = {},
): BotClient {
  const client = new WebClient(token, {
    ...oneAttemptOptions({ slackApiUrl, timeoutMs }),
    logLevel: LogLevel.ERROR,
  });
  const cooldown = (method: string) => database.read((sql) => readCooldown(sql, method, now()));

  async function failed(method: string, error: unknown): Promise<SlackCall<never>> {
    const failure = readCallFailure(error);
    if (failure === null) throw error;
    switch (failure.kind) {
      case "rate_limited": {
        const until = now() + failure.retryAfterSeconds * 1000;
        return {
          kind: "rate_limited",
          until: await database.write((transaction) => holdMethod(transaction, method, until)),
        };
      }
      case "auth_failed":
        if (await database.write((transaction) => markAuthFailed(transaction, now()))) {
          onAuthFailed(failure.error);
        }
        return failure;
      case "error":
      case "unknown":
        return failure;
    }
  }

  return {
    cooldown,
    async call(method, run) {
      const until = await cooldown(method);
      if (until !== null) return { kind: "rate_limited", until };
      try {
        return { kind: "ok", result: await run(client) };
      } catch (error) {
        return failed(method, error);
      }
    },
  };
}

/**
 * Shares a client's cooldowns and token failures, checking `usable` inside each SDK callback.
 * The supervisor keeps the original client so its identity check can make this view usable.
 */
export function guardBotClient(bot: BotClient, usable: () => boolean): BotClient {
  return {
    cooldown: (method) => bot.cooldown(method),
    async call(method, run) {
      const call = await bot.call(method, async (client) =>
        usable()
          ? { kind: "called" as const, result: await run(client) }
          : { kind: "unusable" as const },
      );
      if (call.kind !== "ok") return call;
      return call.result.kind === "unusable"
        ? { kind: "unusable" }
        : { kind: "ok", result: call.result.result };
    },
  };
}

/**
 * Options for a Web API client that makes one attempt per call, rejects a 429 instead of waiting it
 * out, and gives up after `timeoutMs`.
 */
export function oneAttemptOptions({
  slackApiUrl,
  timeoutMs = slackCallTimeoutMs,
}: {
  slackApiUrl?: string;
  timeoutMs?: number;
}) {
  return {
    slackApiUrl,
    timeout: timeoutMs,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    allowAbsoluteUrls: false,
  } satisfies WebClientOptions;
}

/** Why a call failed, as the SDK reported it. */
export type CallFailure =
  /** Slack asked the bridge to wait `retryAfterSeconds` before calling the method again. */
  | { kind: "rate_limited"; retryAfterSeconds: number }
  /** Slack rejected the token with `error`. */
  | { kind: "auth_failed"; error: string }
  /** Slack refused the call with an error code. */
  | { kind: "error"; error: string; data: WebAPICallResult }
  /** No answer came back, or the answer wasn't Slack's, so the call may have taken effect. */
  | { kind: "unknown"; detail: string };

/**
 * Reads why a call failed from what the SDK threw, or null when `error` isn't the SDK reporting a
 * call, such as a storage error.
 */
export function readCallFailure(error: unknown): CallFailure | null {
  const retryAfter = retryAfterOf(error);
  if (retryAfter !== null) return { kind: "rate_limited", retryAfterSeconds: retryAfter };
  if (error instanceof WebAPIPlatformError) {
    const code: unknown = error.data.error;
    if (!isErrorCode(code)) return { kind: "unknown", detail: "unreadable response" };
    if (isAuthFailure(code)) return { kind: "auth_failed", error: code };
    return { kind: "error", error: code, data: error.data };
  }
  if (error instanceof WebAPIRequestError) {
    return { kind: "unknown", detail: error.original.message };
  }
  if (error instanceof WebAPIHTTPError) {
    return { kind: "unknown", detail: `HTTP ${error.statusCode}` };
  }
  return null;
}

/**
 * How many seconds Slack asked the bridge to hold a method back, or null when `error` isn't a rate
 * limit. Slack limits a call with a 429 or an ok:false body, and a limit whose Retry-After the SDK
 * can't read holds the method back for a minute.
 */
function retryAfterOf(error: unknown): number | null {
  if (error instanceof WebAPIRateLimitedError) return error.retryAfter;
  if (error instanceof WebAPIPlatformError && isRateLimit(error.data.error)) {
    return error.data.response_metadata?.retryAfter ?? defaultRetryAfterSeconds;
  }
  if (error instanceof Error && error.message.startsWith(unreadableRetryAfter)) {
    return defaultRetryAfterSeconds;
  }
  return null;
}

async function readCooldown(sql: Bun.SQL, method: string, now: number): Promise<number | null> {
  const [row] = await sql<{ next_attempt_at: number }[]>`
    SELECT next_attempt_at FROM rate_limits WHERE method = ${method} AND next_attempt_at > ${now}
  `;
  return row?.next_attempt_at ?? null;
}

/**
 * Holds `method` back until `until`, or longer when an earlier 429 asked for longer, and returns
 * when it may next be called.
 */
async function holdMethod(transaction: Bun.SQL, method: string, until: number): Promise<number> {
  const [row] = await transaction<{ next_attempt_at: number }[]>`
    INSERT INTO rate_limits (method, next_attempt_at) VALUES (${method}, ${until})
    ON CONFLICT (method) DO UPDATE
      SET next_attempt_at = max(next_attempt_at, excluded.next_attempt_at)
    RETURNING next_attempt_at
  `;
  return row.next_attempt_at;
}

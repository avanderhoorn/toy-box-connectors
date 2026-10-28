import type { BridgeDatabase } from "@bridge/server/database";
import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type WebAPICallResult,
} from "@slack/web-api";
import { isAuthFailure } from "@slackapi/model/errors";
import { markAuthFailed } from "./installation";

// The bot's Web API client.
//
// Every call the bridge makes with the bot token goes through one client, so a 429 holds that
// method back for every caller until the time Slack named, while other methods keep moving. The SDK
// makes one attempt per call: its retries would resend a post whose response was lost, and its own
// rate limit handling would stall every method behind one. A call that gets no answer may still
// have taken effect, so it's reported as unknown, and its caller decides what happens next.

/** How long a call may take before its outcome is unknown. */
export const slackCallTimeoutMs = 10_000;

/** What became of one call. */
export type SlackCall<Result> =
  | { kind: "ok"; result: Result }
  /** Slack asked the bridge to wait until `until` before calling this method again. Nothing was sent. */
  | { kind: "rate_limited"; until: number }
  /** Slack rejected the bot token, and the installation is now auth_failed. */
  | { kind: "auth_failed"; error: string }
  /** Slack refused the call with an error code. */
  | { kind: "error"; error: string; data: WebAPICallResult }
  /** No answer came back, from a timeout, a lost connection or an HTTP error, so the call may have taken effect. */
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
  /** Called after a call finds Slack rejecting the token and puts an active installation in auth_failed. */
  onAuthFailed?: () => void;
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
  const client = createWebClient(token, { slackApiUrl, timeoutMs });
  const cooldown = (method: string) => database.read((sql) => readCooldown(sql, method, now()));

  async function failed(method: string, error: unknown): Promise<SlackCall<never>> {
    if (error instanceof WebAPIRateLimitedError) {
      const until = now() + error.retryAfter * 1000;
      return {
        kind: "rate_limited",
        until: await database.write((transaction) => holdMethod(transaction, method, until)),
      };
    }
    if (error instanceof WebAPIPlatformError) {
      const code = error.data.error;
      if (!isAuthFailure(code)) return { kind: "error", error: code, data: error.data };
      if (await database.write((transaction) => markAuthFailed(transaction, now()))) onAuthFailed();
      return { kind: "auth_failed", error: code };
    }
    if (error instanceof WebAPIRequestError) {
      return { kind: "unknown", detail: error.original.message };
    }
    if (error instanceof WebAPIHTTPError) {
      return { kind: "unknown", detail: `HTTP ${error.statusCode}` };
    }
    throw error;
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
 * A Web API client that makes one attempt per call, rejects a 429 instead of waiting it out, and
 * gives up after `timeoutMs`.
 */
function createWebClient(
  token: string,
  {
    slackApiUrl,
    timeoutMs = slackCallTimeoutMs,
  }: { slackApiUrl?: string; timeoutMs?: number } = {},
): WebClient {
  return new WebClient(token, {
    slackApiUrl,
    timeout: timeoutMs,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    allowAbsoluteUrls: false,
    logLevel: LogLevel.ERROR,
  });
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

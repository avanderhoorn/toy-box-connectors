import type { BridgeDatabase } from "@bridge/server/database";
import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type Logger,
  type WebAPICallResult,
  type WebClientOptions,
} from "@slack/web-api";
import { log } from "@/shared/log";
import { isAuthFailure, isErrorCode, isRateLimit, isRequestFault } from "../model/errors";
import { markAuthFailed } from "./installation";

export const slackCallTimeoutMs = 10_000;
export type CallFailure =
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "auth_failed"; error: string }
  | { kind: "error"; error: string; data: WebAPICallResult }
  | { kind: "unknown"; detail: string };
export type SlackCall<Result> =
  | { kind: "ok"; result: Result }
  | { kind: "rate_limited"; until: number }
  | Exclude<CallFailure, { kind: "rate_limited" }>;
export type BotClient = {
  call<Result>(
    method: string,
    run: (client: WebClient) => Promise<Result>,
  ): Promise<SlackCall<Result>>;
};
export type BotClientOptions = {
  slackApiUrl?: string;
  timeoutMs?: number;
  onAuthFailed?: (error: string) => void;
  now?: () => number;
};

/** One client shares method cooldowns. Only its caller may decide to retry a write. */
export function createBotClient(
  database: BridgeDatabase,
  token: string,
  { slackApiUrl, timeoutMs, onAuthFailed, now = Date.now }: BotClientOptions = {},
): BotClient {
  const client = new WebClient(token, {
    ...oneAttemptOptions({ slackApiUrl, timeoutMs }),
    logger: silentLogger,
  });
  const cooldowns = new Map<string, number>();
  return {
    async call(method, run) {
      const heldUntil = cooldowns.get(method) ?? 0;
      if (heldUntil > now()) return { kind: "rate_limited", until: heldUntil };
      try {
        return { kind: "ok", result: await run(client) };
      } catch (error) {
        const failure = readCallFailure(error);
        if (!failure) throw error;
        if (failure.kind === "rate_limited") {
          const until = Math.max(
            cooldowns.get(method) ?? 0,
            now() + failure.retryAfterSeconds * 1000,
          );
          cooldowns.set(method, until);
          return { kind: "rate_limited", until };
        }
        if (failure.kind === "auth_failed" && (await database.write(markAuthFailed))) {
          onAuthFailed?.(failure.error);
        }
        // A request Slack explains what was wrong with is the bridge's mistake, and its caller may
        // keep only the code, so the owner hears of it here.
        if (failure.kind === "error" && isRequestFault(failure.data.response_metadata?.messages))
          log(`Slack refused ${method} with ${failure.error}.`);
        return failure;
      }
    },
  };
}

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

/**
 * Keeps the Slack SDKs off stderr. Their loggers print payloads, and Slack's explanations of failed
 * calls, which can quote them. The bridge says what went wrong itself.
 */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  setName() {},
  getLevel: () => LogLevel.ERROR,
};

export function readCallFailure(error: unknown): CallFailure | null {
  if (error instanceof WebAPIRateLimitedError)
    return { kind: "rate_limited", retryAfterSeconds: error.retryAfter };
  if (error instanceof WebAPIPlatformError) {
    const code: unknown = error.data.error;
    if (!isErrorCode(code)) return { kind: "unknown", detail: "unreadable response" };
    if (isRateLimit(code))
      return {
        kind: "rate_limited",
        retryAfterSeconds: error.data.response_metadata?.retryAfter ?? 60,
      };
    if (isAuthFailure(code)) return { kind: "auth_failed", error: code };
    return { kind: "error", error: code, data: error.data };
  }
  if (error instanceof WebAPIRequestError)
    return { kind: "unknown", detail: error.original.message };
  if (error instanceof WebAPIHTTPError)
    return { kind: "unknown", detail: `HTTP ${error.statusCode}` };
  // SDK 8.2.0 throws an untyped Error for a 429 with an unreadable Retry-After.
  if (
    error instanceof Error &&
    error.message.startsWith("Retry header did not contain a valid timeout")
  )
    return { kind: "rate_limited", retryAfterSeconds: 60 };
  return null;
}

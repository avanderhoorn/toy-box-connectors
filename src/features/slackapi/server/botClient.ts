import {
  LogLevel,
  SlackError,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type Logger,
  type WebAPICallResult,
  type WebClientOptions,
} from "@slack/web-api";
import { ZodError } from "zod";
import { log as bridgeLog, type Log } from "@/shared/log";
import { issuesOf } from "../model/envelopes";
import { isAuthFailure, isErrorCode, isRateLimit, isRequestFault } from "../model/errors";
import { downloadFile, slackFilesOrigin, type Download } from "./download";
import { uploadFile, type Upload } from "./upload";

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
  /**
   * Runs `run` with the bot's Slack client. An answer the SDK can't read, or that fails the schema
   * `run` reads it with, is `unknown`, as one that never came is. Anything else `run` throws is the
   * bridge's own error, and is thrown on.
   */
  call<Result>(
    method: string,
    run: (client: WebClient) => Promise<Result>,
  ): Promise<SlackCall<Result>>;
  /** Reads the bytes of a file files.info described, sending the token only to Slack's file host. */
  download(file: { url: string; size: number }): Promise<Download>;
  /** Sends a file's bytes where files.getUploadURLExternal said to, if that's Slack's file host. */
  upload(file: { url: string; bytes: Uint8Array }): Promise<Upload>;
};
export type BotClientOptions = {
  slackApiUrl?: string;
  timeoutMs?: number;
  /** Called each time Slack rejects the token, with the error it gave. */
  onAuthFailed?: (error: string) => void;
  now?: () => number;
  /** Where the client says what Slack refused, the bridge's log unless set. */
  log?: Log;
};

/**
 * One client shares method cooldowns. Only its caller may decide to retry a write. It alone holds
 * the token, so files download through it too, and it knows Slack's file host, so they upload
 * through it.
 */
export function createBotClient(
  token: string,
  { slackApiUrl, timeoutMs, onAuthFailed, now = Date.now, log = bridgeLog }: BotClientOptions = {},
): BotClient {
  const client = new ReadingClient(token, {
    ...oneAttemptOptions({ slackApiUrl, timeoutMs }),
    logger: silentLogger,
  });
  // Fake Slack serves and takes files beside its API.
  const filesOrigin = slackApiUrl ? new URL(slackApiUrl).origin : slackFilesOrigin;
  const cooldowns = new Map<string, number>();
  return {
    async call(method, run) {
      const heldUntil = cooldowns.get(method) ?? 0;
      if (heldUntil > now()) return { kind: "rate_limited", until: heldUntil };
      try {
        return { kind: "ok", result: await run(client) };
      } catch (error) {
        const unread = unreadPart(error);
        if (unread !== null) {
          log(`Couldn't read Slack's answer to ${method}: ${unread}.`);
          return { kind: "unknown", detail: "unreadable response" };
        }
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
        if (failure.kind === "auth_failed") onAuthFailed?.(failure.error);
        // A request Slack explains what was wrong with is the bridge's mistake, and its caller may
        // keep only the code, so the owner hears of it here.
        if (failure.kind === "error" && isRequestFault(failure.data.response_metadata?.messages))
          log(`Slack refused ${method} with ${failure.error}.`);
        return failure;
      }
    },
    download: ({ url, size }) => downloadFile({ url, size, token }, { origin: filesOrigin }),
    upload: ({ url, bytes }) => uploadFile({ url, bytes }, { origin: filesOrigin }),
  };
}

/**
 * The SDK's client, except that an answer the SDK fails to read, such as JSON null, a bare string
 * or a null `response_metadata`, throws UnreadableAnswer rather than whatever the SDK tripped on.
 */
class ReadingClient extends WebClient {
  override async apiCall(method: string, options?: Record<string, unknown>) {
    try {
      return await super.apiCall(method, options);
    } catch (error) {
      if (error instanceof SlackError || isUnreadableRetryAfter(error)) throw error;
      throw new UnreadableAnswer(`The Slack SDK couldn't read its answer to ${method}`, {
        cause: error,
      });
    }
  }
}

class UnreadableAnswer extends Error {}

/** What the bridge couldn't read in an answer, without the answer's text, or null if it read it. */
function unreadPart(error: unknown): string | null {
  if (error instanceof UnreadableAnswer) return "the Slack SDK failed on it";
  if (error instanceof ZodError) return issuesOf(error).join(", ");
  return null;
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
  if (isUnreadableRetryAfter(error)) return { kind: "rate_limited", retryAfterSeconds: 60 };
  return null;
}

/** SDK 8.2.0 throws an untyped Error for a 429 with an unreadable Retry-After. */
function isUnreadableRetryAfter(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Retry header did not contain a valid timeout")
  );
}

import type { ChannelSuspendReason } from "@links/model/audience";

// Web API errors.
//
// Slack answers a failed call with an error code. Most are the caller's to classify, but a few say
// the bot token itself no longer works, or that Slack is limiting the call, and every caller treats
// those the same way.

// The workspace is moving into an Enterprise org, so its tokens stop working until it's reset.
const orgMigrations: ReadonlySet<string> = new Set(["team_added_to_org", "org_login_required"]);

const authFailures: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  ...orgMigrations,
]);

/** Whether `error` means Slack rejected the bot token, which puts the installation in auth_failed. */
export function isAuthFailure(error: string): boolean {
  return authFailures.has(error);
}

/** Whether `error` means Slack rejects every token while the workspace moves into an Enterprise org. */
export function isOrgMigration(error: string): boolean {
  return orgMigrations.has(error);
}

// Besides a 429, Slack can limit a call with one of these in an ok:false body.
const rateLimits: ReadonlySet<string> = new Set(["ratelimited", "rate_limited"]);

/** Whether `error` means Slack is limiting the call, which holds its method back like a 429. */
export function isRateLimit(error: string): boolean {
  return rateLimits.has(error);
}

/**
 * Whether `error` reads as one of Slack's error codes. The SDK reports a body that isn't JSON as an
 * error whose code is the body itself, and nothing between the bridge and Slack names a code.
 */
export function isErrorCode(error: unknown): error is string {
  return typeof error === "string" && /^[a-z][a-z0-9_]*$/.test(error);
}

/**
 * Why an error shuts the bot out of a whole channel. Thread-only restrictions stay with the
 * individual call. https://docs.slack.dev/reference/methods/chat.postMessage/#errors
 */
export function channelFailureReason(error: string): ChannelSuspendReason | null {
  switch (error) {
    case "not_in_channel":
      return "bot_removed";
    case "channel_not_found":
      return "channel_not_found";
    case "is_archived":
      return "channel_archived";
    case "restricted_action":
    case "restricted_action_read_only_channel":
    case "team_access_not_granted":
    case "ekm_access_denied":
      return "channel_restricted";
    default:
      return null;
  }
}

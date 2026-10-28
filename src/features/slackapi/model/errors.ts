// Web API errors.
//
// Slack answers a failed call with an error code. Most are the caller's to classify, but a few say
// the bot token itself no longer works, and every caller treats those the same way.

const authFailures: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  // The workspace is moving into an Enterprise org, so its tokens stop working until it's reset.
  "team_added_to_org",
  "org_login_required",
]);

/** Whether `error` means Slack rejected the bot token, which puts the installation in auth_failed. */
export function isAuthFailure(error: string): boolean {
  return authFailures.has(error);
}

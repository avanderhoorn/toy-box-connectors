import { expect, test } from "bun:test";
import {
  channelFailureReason,
  isAuthFailure,
  isErrorCode,
  isOrgMigration,
  isRateLimit,
} from "./errors";

test("a rejected token, or a workspace moving into an Enterprise org, is an auth failure", () => {
  for (const error of [
    "invalid_auth",
    "not_authed",
    "account_inactive",
    "token_revoked",
    "token_expired",
    "team_added_to_org",
    "org_login_required",
  ]) {
    expect(isAuthFailure(error)).toBe(true);
  }
});

test("an error about one call, a channel or a missing scope is the caller's to handle", () => {
  for (const error of [
    "not_in_channel",
    "channel_not_found",
    "missing_scope",
    "internal_error",
    "ratelimited",
  ]) {
    expect(isAuthFailure(error)).toBe(false);
  }
});

test("only a workspace moving into an Enterprise org is a migration", () => {
  expect(isOrgMigration("team_added_to_org")).toBe(true);
  expect(isOrgMigration("org_login_required")).toBe(true);
  for (const error of ["invalid_auth", "token_revoked", "account_inactive", "missing_scope"]) {
    expect(isOrgMigration(error)).toBe(false);
  }
});

test("Slack limiting a call is a rate limit whichever spelling it uses", () => {
  expect(isRateLimit("ratelimited")).toBe(true);
  expect(isRateLimit("rate_limited")).toBe(true);
  for (const error of ["internal_error", "invalid_auth", "message_limit_exceeded"]) {
    expect(isRateLimit(error)).toBe(false);
  }
});

test("an error code is Slack's own word, never a body that isn't JSON", () => {
  for (const error of ["not_in_channel", "restricted_action_read_only_channel", "msg_too_long"]) {
    expect(isErrorCode(error)).toBe(true);
  }
  for (const error of [
    "<html>Blocked</html>",
    "upstream connect error",
    "Bad Gateway",
    "",
    "not_in_channel\n",
    undefined,
  ]) {
    expect(isErrorCode(error)).toBe(false);
  }
});

test.each([
  ["not_in_channel", "bot_removed"],
  ["channel_not_found", "channel_not_found"],
  ["is_archived", "channel_archived"],
  ["restricted_action", "channel_restricted"],
  ["restricted_action_read_only_channel", "channel_restricted"],
  ["team_access_not_granted", "channel_restricted"],
  ["ekm_access_denied", "channel_restricted"],
] as const)("%s suspends the channel with %s", (error, reason) => {
  expect(channelFailureReason(error)).toBe(reason);
});

test.each([
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "cannot_reply_to_message",
  "thread_not_found",
  "missing_scope",
  "internal_error",
  "token_expired",
])("%s does not suspend a whole channel", (error) => {
  expect(channelFailureReason(error)).toBeNull();
});

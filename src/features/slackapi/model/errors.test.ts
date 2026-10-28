import { expect, test } from "bun:test";
import { isAuthFailure, isErrorCode, isRateLimit } from "./errors";

test("a rejected token, or a workspace moving into an Enterprise org, is an auth failure", () => {
  for (const error of [
    "invalid_auth",
    "not_authed",
    "account_inactive",
    "token_revoked",
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

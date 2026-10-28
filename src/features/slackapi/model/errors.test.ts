import { expect, test } from "bun:test";
import { isAuthFailure } from "./errors";

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

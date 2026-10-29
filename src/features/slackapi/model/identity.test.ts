import { describe, expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import {
  missingTokensProblem,
  refusalProblem,
  rejectedTokensProblem,
  type IdentityRefusal,
} from "./identity";

describe("what the owner does about a token", () => {
  test("serve at their own terminal asks for each one missing, and the running bridge then restarts", () => {
    expect(missingTokensProblem(["SLACK_APP_TOKEN"], DEFAULT_APP)).toBe(
      "Have the owner run `toy-box-slack serve` at their own terminal, which asks for SLACK_APP_TOKEN, and then restart the bridge.",
    );
    expect(missingTokensProblem(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], DEFAULT_APP)).toBe(
      "Have the owner run `toy-box-slack serve` at their own terminal, which asks for SLACK_BOT_TOKEN and SLACK_APP_TOKEN, and then restart the bridge.",
    );
  });

  test("Slack rejected one, so its line goes and serve asks for it again", () => {
    expect(rejectedTokensProblem([["SLACK_BOT_TOKEN", "token_revoked"]], DEFAULT_APP)).toBe(
      "Slack rejected SLACK_BOT_TOKEN with token_revoked. Have the owner delete the SLACK_BOT_TOKEN line from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    );
  });

  test("Slack rejected both, so both are replaced at once", () => {
    const rejected = [
      ["SLACK_BOT_TOKEN", "token_revoked"],
      ["SLACK_APP_TOKEN", "invalid_auth"],
    ] as const;
    expect(rejectedTokensProblem(rejected, DEFAULT_APP)).toBe(
      "Slack rejected SLACK_BOT_TOKEN with token_revoked and SLACK_APP_TOKEN with invalid_auth. Have the owner delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for them again, and then restart the bridge.",
    );
  });
});

describe("what the owner does about a refusal", () => {
  const refusals: Record<IdentityRefusal["reason"], [IdentityRefusal, string]> = {
    uninstalled: [
      { reason: "uninstalled" },
      "Slack was uninstalled. To install it again, have the owner stop the bridge, remove bridge.db and its -wal/-shm files, delete the SLACK_BOT_TOKEN line from the bridge's credentials.env, install the app in Slack again, and run `toy-box-slack serve` at their own terminal, which asks for its new bot token.",
    ],
    not_bot: [
      { reason: "not_bot" },
      "SLACK_BOT_TOKEN isn't a bot token. Have the owner delete the SLACK_BOT_TOKEN line from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    ],
    other_app: [
      { reason: "other_app" },
      "SLACK_APP_TOKEN belongs to another Slack app than SLACK_BOT_TOKEN. Have the owner delete the SLACK_APP_TOKEN line from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    ],
    org_wide: [
      { reason: "org_wide" },
      "SLACK_BOT_TOKEN is from an install across an Enterprise org, which the bridge doesn't support. Have the owner install the app in one workspace, delete the SLACK_BOT_TOKEN line from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    ],
    rotating: [
      { reason: "rotating" },
      "The Slack app's tokens rotate, which the bridge doesn't support, and token rotation can't be turned off once it's on. Have the owner create a Slack app from docs/manifest.yaml, delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for the new app's tokens, and then restart the bridge.",
    ],
    moved_org: [
      { reason: "moved_org" },
      "The workspace joined or left an Enterprise org since the bridge was set up. The bridge has to start over, which forgets every link, so have the owner stop the bridge, remove bridge.db and its -wal/-shm files, and start it again.",
    ],
    mismatch: [
      { reason: "mismatch", field: "teamId", found: "T-other" },
      "SLACK_BOT_TOKEN belongs to another workspace (T-other) than the one the bridge was set up for. Have the owner delete the SLACK_BOT_TOKEN line from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge. To move the bridge to that workspace instead, which forgets every link, have the owner stop the bridge, remove bridge.db and its -wal/-shm files, and start it again.",
    ],
    duplicate_app: [
      { reason: "duplicate_app", heldBy: "releases" },
      "The default app's SLACK_BOT_TOKEN belongs to the same Slack app as the releases app's, and each app the bridge hosts needs a Slack app of its own. Have the owner create a Slack app from docs/manifest.yaml, delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for the new app's tokens, and then restart the bridge.",
    ],
  };

  test.each(Object.entries(refusals))("%s", (_, [refusal, problem]) => {
    expect(refusalProblem(refusal, DEFAULT_APP)).toBe(problem);
  });

  test.each([
    ["teamId", "workspace"],
    ["appId", "Slack app"],
    ["botId", "bot"],
    ["botUserId", "bot user"],
  ] as const)("a token whose %s differs belongs to another %s", (field, other) => {
    const problem = refusalProblem({ reason: "mismatch", field, found: "X-other" }, DEFAULT_APP);
    expect(problem).toStartWith(`SLACK_BOT_TOKEN belongs to another ${other} (X-other) than `);
    expect(problem).toContain(`To move the bridge to that ${other} instead,`);
  });
});

describe("what the owner does about an added app's tokens", () => {
  test("serve asks for each one missing by the app's name", () => {
    expect(missingTokensProblem(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], "releases")).toBe(
      "Have the owner run `toy-box-slack serve` at their own terminal, which asks for the releases app's SLACK_BOT_TOKEN and SLACK_APP_TOKEN, and then restart the bridge.",
    );
  });

  test("a token Slack rejected goes from the app's own credentials.env", () => {
    const rejected = [
      ["SLACK_BOT_TOKEN", "token_revoked"],
      ["SLACK_APP_TOKEN", "invalid_auth"],
    ] as const;
    expect(rejectedTokensProblem(rejected, "releases")).toBe(
      "Slack rejected the releases app's SLACK_BOT_TOKEN with token_revoked and SLACK_APP_TOKEN with invalid_auth. Have the owner delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for them again, and then restart the bridge.",
    );
  });

  // Starting an added app over forgets only its own links, and leaves its tokens in place.
  const refusals: Record<IdentityRefusal["reason"], [IdentityRefusal, string]> = {
    uninstalled: [
      { reason: "uninstalled" },
      "The releases app was uninstalled from Slack. To install it again, have the owner stop the bridge, remove bridge.db and its -wal/-shm files from the bridge's apps/releases folder, delete the SLACK_BOT_TOKEN line from the bridge's apps/releases/credentials.env, install the app in Slack again, and run `toy-box-slack serve` at their own terminal, which asks for its new bot token.",
    ],
    not_bot: [
      { reason: "not_bot" },
      "The releases app's SLACK_BOT_TOKEN isn't a bot token. Have the owner delete the SLACK_BOT_TOKEN line from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    ],
    other_app: [
      { reason: "other_app" },
      "The releases app's SLACK_APP_TOKEN belongs to another Slack app than SLACK_BOT_TOKEN. Have the owner delete the SLACK_APP_TOKEN line from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    ],
    org_wide: [
      { reason: "org_wide" },
      "The releases app's SLACK_BOT_TOKEN is from an install across an Enterprise org, which the bridge doesn't support. Have the owner install the app in one workspace, delete the SLACK_BOT_TOKEN line from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge.",
    ],
    rotating: [
      { reason: "rotating" },
      "The releases app's tokens rotate, which the bridge doesn't support, and token rotation can't be turned off once it's on. Have the owner create a Slack app from docs/manifest.yaml, delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for the new app's tokens, and then restart the bridge.",
    ],
    moved_org: [
      { reason: "moved_org" },
      "The workspace joined or left an Enterprise org since the releases app was set up. The releases app has to start over, which forgets every link through it, so have the owner stop the bridge, remove bridge.db and its -wal/-shm files from the bridge's apps/releases folder, and start it again.",
    ],
    mismatch: [
      { reason: "mismatch", field: "teamId", found: "T-other" },
      "The releases app's SLACK_BOT_TOKEN belongs to another workspace (T-other) than the one the releases app was set up for. Have the owner delete the SLACK_BOT_TOKEN line from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge. To move the releases app to that workspace instead, which forgets every link through it, have the owner stop the bridge, remove bridge.db and its -wal/-shm files from the bridge's apps/releases folder, and start it again.",
    ],
    duplicate_app: [
      { reason: "duplicate_app", heldBy: "default" },
      "The releases app's SLACK_BOT_TOKEN belongs to the same Slack app as the default app's, and each app the bridge hosts needs a Slack app of its own. Have the owner create a Slack app from docs/manifest.yaml, delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for the new app's tokens, and then restart the bridge.",
    ],
  };

  test.each(Object.entries(refusals))("%s", (_, [refusal, problem]) => {
    expect(refusalProblem(refusal, "releases")).toBe(problem);
  });
});

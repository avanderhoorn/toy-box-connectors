import { describe, expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import { refusalProblem, rejectedTokensProblem, type IdentityRefusal } from "./identity";

describe("what the owner does about a refusal", () => {
  const refusals = {
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
    duplicate_app: [
      { reason: "duplicate_app", heldBy: "releases" },
      "The default app's SLACK_BOT_TOKEN belongs to the same Slack app as the releases app's, and each app the bridge hosts needs a Slack app of its own. Have the owner create a Slack app from docs/manifest.yaml, delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's credentials.env, run `toy-box-slack serve` at their own terminal, which asks for the new app's tokens, and then restart the bridge.",
    ],
  } satisfies Partial<Record<IdentityRefusal["reason"], [IdentityRefusal, string]>>;

  test.each(Object.entries(refusals))("%s", (_, [refusal, problem]) => {
    expect(refusalProblem(refusal, DEFAULT_APP)).toBe(problem);
  });
});

describe("what the owner does about an added app's tokens", () => {
  test("a token Slack rejected goes from the app's own credentials.env", () => {
    const rejected = [
      ["SLACK_BOT_TOKEN", "token_revoked"],
      ["SLACK_APP_TOKEN", "invalid_auth"],
    ] as const;
    expect(rejectedTokensProblem(rejected, "releases")).toBe(
      "Slack rejected the releases app's SLACK_BOT_TOKEN with token_revoked and SLACK_APP_TOKEN with invalid_auth. Have the owner delete the SLACK_BOT_TOKEN and SLACK_APP_TOKEN lines from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for them again, and then restart the bridge.",
    );
  });

  // The uninstalled hint names the app's files itself, not through the helpers the others share,
  // and starting an added app over forgets only its own links and leaves its tokens in place.
  const refusals = {
    uninstalled: [
      { reason: "uninstalled" },
      "The releases app was uninstalled from Slack. To install it again, have the owner stop the bridge, remove bridge.db and its -wal/-shm files from the bridge's apps/releases folder, delete the SLACK_BOT_TOKEN line from the bridge's apps/releases/credentials.env, install the app in Slack again, and run `toy-box-slack serve` at their own terminal, which asks for its new bot token.",
    ],
    mismatch: [
      { reason: "mismatch", field: "teamId", found: "T-other" },
      "The releases app's SLACK_BOT_TOKEN belongs to another workspace (T-other) than the one the releases app was set up for. Have the owner delete the SLACK_BOT_TOKEN line from the bridge's apps/releases/credentials.env, run `toy-box-slack serve` at their own terminal, which asks for it again, and then restart the bridge. To move the releases app to that workspace instead, which forgets every link through it, have the owner stop the bridge, remove bridge.db and its -wal/-shm files from the bridge's apps/releases folder, and start it again.",
    ],
  } satisfies Partial<Record<IdentityRefusal["reason"], [IdentityRefusal, string]>>;

  test.each(Object.entries(refusals))("%s", (_, [refusal, problem]) => {
    expect(refusalProblem(refusal, "releases")).toBe(problem);
  });
});

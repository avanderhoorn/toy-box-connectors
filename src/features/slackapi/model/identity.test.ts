import { describe, expect, test } from "bun:test";
import {
  authTestSchema,
  botInfoSchema,
  checkOwner,
  helloRefusal,
  identityOf,
  identityRefusal,
  refusalProblem,
  rejectedTokenProblem,
  tokensRefusal,
  type SlackIdentity,
  type TokenOwner,
} from "./identity";

/** auth.test's answer for a workspace install's bot token, with fields the bridge doesn't keep. */
const answer = {
  ok: true,
  url: "https://acme.slack.com/",
  team: "Acme",
  user: "toy-box",
  team_id: "T-home",
  user_id: "U-bot",
  bot_id: "B-bot",
  is_enterprise_install: false,
};

const owner: TokenOwner = {
  workspaceUrl: "https://acme.slack.com/",
  teamId: "T-home",
  enterpriseId: null,
  userId: "U-bot",
  botId: "B-bot",
  orgWide: false,
  rotates: false,
};

/** The identity `createStoredInstallation` stores. */
const stored: SlackIdentity = {
  teamId: "T-home",
  enterpriseId: null,
  appId: "A-app",
  botId: "B-bot",
  botUserId: "U-bot",
};

describe("reading Slack's answers", () => {
  test("auth.test reads as whose token it is", () => {
    expect(authTestSchema.parse(answer)).toEqual(owner);
  });

  test("an Enterprise workspace names its org, and an empty org is none", () => {
    expect(authTestSchema.parse({ ...answer, enterprise_id: "E-org" }).enterpriseId).toBe("E-org");
    expect(authTestSchema.parse({ ...answer, enterprise_id: "" }).enterpriseId).toBeNull();
  });

  test("an expiry means the token rotates, and an Enterprise install is org-wide", () => {
    expect(authTestSchema.parse({ ...answer, expires_in: 43_200 }).rotates).toBe(true);
    expect(authTestSchema.parse({ ...answer, is_enterprise_install: true }).orgWide).toBe(true);
  });

  test("a user token has no bot, and a missing address stays unknown", () => {
    const { bot_id: _, url: __, ...userAnswer } = answer;
    expect(authTestSchema.parse(userAnswer)).toMatchObject({ botId: null, workspaceUrl: null });
  });

  test("an answer that doesn't name the workspace or the token's user can't be read", () => {
    const { team_id: _, ...withoutTeam } = answer;
    expect(authTestSchema.safeParse(withoutTeam).success).toBe(false);
    expect(authTestSchema.safeParse({ ...answer, user_id: "" }).success).toBe(false);
  });

  test("bots.info reads as the bot's app and user, and can't be read without both", () => {
    const bot = { id: "B-bot", deleted: false, name: "toy-box", app_id: "A-app", user_id: "U-bot" };
    expect(botInfoSchema.parse({ ok: true, bot })).toEqual({ appId: "A-app", userId: "U-bot" });
    const { app_id: _, ...withoutApp } = bot;
    expect(botInfoSchema.safeParse({ ok: true, bot: withoutApp }).success).toBe(false);
    const { user_id: __, ...withoutUser } = bot;
    expect(botInfoSchema.safeParse({ ok: true, bot: withoutUser }).success).toBe(false);
  });
});

describe("refusing credentials v1 doesn't support", () => {
  test("a token that starts with xoxe. rotates, whichever it is", () => {
    const tokens = { botToken: "xoxb-1", appToken: "xapp-1" };
    expect(tokensRefusal(tokens)).toBeNull();
    expect(tokensRefusal({ ...tokens, botToken: "xoxe.xoxb-1" })).toEqual({
      reason: "rotating",
      tokens: ["SLACK_BOT_TOKEN"],
    });
    expect(tokensRefusal({ ...tokens, appToken: "xoxe.xapp-1" })).toEqual({
      reason: "rotating",
      tokens: ["SLACK_APP_TOKEN"],
    });
    expect(tokensRefusal({ botToken: "xoxe.xoxb-1", appToken: "xoxe.xapp-1" })).toEqual({
      reason: "rotating",
      tokens: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    });
  });

  test("a workspace bot's token names its bot", () => {
    expect(checkOwner(owner)).toEqual({ kind: "bot", owner: { ...owner, botId: "B-bot" } });
  });

  test("a token that expires, an org-wide install's, or a user's is refused", () => {
    expect(checkOwner({ ...owner, rotates: true })).toEqual({
      kind: "refused",
      refusal: { reason: "rotating", tokens: ["SLACK_BOT_TOKEN"] },
    });
    expect(checkOwner({ ...owner, orgWide: true })).toEqual({
      kind: "refused",
      refusal: { reason: "org_wide" },
    });
    expect(checkOwner({ ...owner, botId: null })).toEqual({
      kind: "refused",
      refusal: { reason: "not_bot" },
    });
  });
});

describe("holding the tokens against the installation", () => {
  test("the bot token's owner and its bot's app make the identity", () => {
    const bot = { appId: "A-app", userId: "U-bot" };
    expect(identityOf({ ...owner, botId: "B-bot", enterpriseId: "E-org" }, bot)).toEqual({
      ...stored,
      enterpriseId: "E-org",
    });
  });

  test("a bot whose user isn't the token's makes no identity", () => {
    const bot = { appId: "A-app", userId: "U-other" };
    expect(identityOf({ ...owner, botId: "B-bot" }, bot)).toBeNull();
  });

  test("the same identity is accepted", () => {
    expect(identityRefusal(stored, { ...stored })).toBeNull();
    const enterprise = { ...stored, enterpriseId: "E-org" };
    expect(identityRefusal(enterprise, { ...enterprise })).toBeNull();
  });

  test("another workspace, app, bot or bot user is refused, naming what differs", () => {
    for (const [field, found] of [
      ["teamId", "T-other"],
      ["appId", "A-other"],
      ["botId", "B-other"],
      ["botUserId", "U-other"],
    ] as const) {
      expect(identityRefusal(stored, { ...stored, [field]: found })).toEqual({
        reason: "mismatch",
        field,
        stored: stored[field],
        found,
      });
    }
  });

  test("another workspace is named first, even when the app and org differ too", () => {
    expect(
      identityRefusal(stored, {
        ...stored,
        teamId: "T-other",
        appId: "A-other",
        enterpriseId: "E-org",
      }),
    ).toMatchObject({ reason: "mismatch", field: "teamId" });
  });

  test("a workspace that joined, left or changed Enterprise org is refused", () => {
    const inOrg = { ...stored, enterpriseId: "E-org" };
    expect(identityRefusal(stored, inOrg)).toEqual({
      reason: "moved_org",
      stored: null,
      found: "E-org",
    });
    expect(identityRefusal(inOrg, stored)).toEqual({
      reason: "moved_org",
      stored: "E-org",
      found: null,
    });
    expect(identityRefusal(inOrg, { ...inOrg, enterpriseId: "E-new" })).toEqual({
      reason: "moved_org",
      stored: "E-org",
      found: "E-new",
    });
  });

  test("Socket Mode's hello must name the installation's app", () => {
    expect(helloRefusal("A-app", "A-app")).toBeNull();
    expect(helloRefusal("A-app", "A-other")).toEqual({
      reason: "other_app",
      stored: "A-app",
      found: "A-other",
    });
    expect(helloRefusal("A-app", null)).toEqual({
      reason: "other_app",
      stored: "A-app",
      found: null,
    });
  });
});

describe("telling the operator what to do", () => {
  test("a mismatch names both sides and the two ways out", () => {
    expect(
      refusalProblem({ reason: "mismatch", field: "botUserId", stored: "U-bot", found: "U-new" }),
    ).toBe(
      "SLACK_BOT_TOKEN belongs to bot user U-new, but the bridge was set up with bot user U-bot. Put back the tokens it was set up with and restart the bridge, or stop the bridge and run `toy-box-slack reset --yes` to start over with these.",
    );
  });

  test("a change of org says why it takes a reset", () => {
    expect(refusalProblem({ reason: "moved_org", stored: null, found: "E-org" })).toBe(
      "The workspace joined Enterprise org E-org since the bridge was set up, so the people it admitted were checked against the old org. To set it up again, stop the bridge and run `toy-box-slack reset --yes`.",
    );
    expect(refusalProblem({ reason: "moved_org", stored: "E-org", found: null })).toStartWith(
      "The workspace left Enterprise org E-org since",
    );
    expect(refusalProblem({ reason: "moved_org", stored: "E-org", found: "E-new" })).toStartWith(
      "The workspace moved from Enterprise org E-org to E-new since",
    );
  });

  test("an app-level token from another app names the app it should come from", () => {
    expect(refusalProblem({ reason: "other_app", stored: "A-app", found: "A-other" })).toBe(
      "SLACK_APP_TOKEN belongs to app A-other, but SLACK_BOT_TOKEN to app A-app. Put an app-level token from app A-app's Basic Information page in credentials.env, then restart the bridge.",
    );
    expect(refusalProblem({ reason: "other_app", stored: "A-app", found: null })).toStartWith(
      "Slack didn't say which app SLACK_APP_TOKEN belongs to",
    );
  });

  test("every refusal says how to get going again", () => {
    for (const refusal of [
      { reason: "uninstalled" },
      { reason: "rotating", tokens: ["SLACK_APP_TOKEN"] },
      { reason: "org_wide" },
      { reason: "not_bot" },
    ] as const) {
      expect(refusalProblem(refusal)).toMatch(/(restart the bridge|reset --yes`)\.$/);
    }
    expect(refusalProblem({ reason: "uninstalled" })).toContain("reinstall the app");
    expect(refusalProblem({ reason: "rotating", tokens: ["SLACK_APP_TOKEN"] })).toStartWith(
      "SLACK_APP_TOKEN rotates, and the bridge needs tokens with rotation off.",
    );
    expect(
      refusalProblem({ reason: "rotating", tokens: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] }),
    ).toStartWith("SLACK_BOT_TOKEN and SLACK_APP_TOKEN rotate, and");
    expect(refusalProblem({ reason: "org_wide" })).toContain("installed to one workspace");
    expect(refusalProblem({ reason: "not_bot" })).toBe(
      "SLACK_BOT_TOKEN isn't a bot token. Put the app's Bot User OAuth Token, which starts with xoxb-, in credentials.env, then restart the bridge.",
    );
  });

  test("a rejected token says which token and where a working one comes from", () => {
    expect(rejectedTokenProblem("SLACK_BOT_TOKEN", "token_revoked")).toBe(
      "Slack rejected SLACK_BOT_TOKEN with token_revoked. Put the app's Bot User OAuth Token, which starts with xoxb-, in credentials.env, then restart the bridge.",
    );
    expect(rejectedTokenProblem("SLACK_APP_TOKEN", "not_allowed_token_type")).toBe(
      "Slack rejected SLACK_APP_TOKEN with not_allowed_token_type. Put an app-level token with connections:write from the app's Basic Information page, which starts with xapp-, in credentials.env, then restart the bridge.",
    );
  });

  test("a workspace moving into an Enterprise org only has to finish moving", () => {
    expect(rejectedTokenProblem("SLACK_BOT_TOKEN", "team_added_to_org")).toBe(
      "Slack is moving the workspace into an Enterprise org and rejects SLACK_BOT_TOKEN with team_added_to_org until that's done.",
    );
    expect(rejectedTokenProblem("SLACK_APP_TOKEN", "org_login_required")).toBe(
      "Slack is moving the workspace into an Enterprise org and rejects SLACK_APP_TOKEN with org_login_required until that's done.",
    );
  });
});

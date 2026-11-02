import { describe, expect, onTestFinished, test } from "bun:test";
import type { ClaimSlackApp } from "@bridge/model/claims";
import type { BridgeDatabase } from "@bridge/server/database";
import { confirmIdentity } from "@bridge/server/identity";
import { captureLog, openTestDatabase } from "@bridge/server/testFixtures";
import { recordUninstall } from "@links/server/lifecycle";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { IdentityRefusal } from "@slackapi/model/identity";
import type { Installation } from "@slackapi/model/installation";
import { createBotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { startFakeSlack, type FakeSlack, type FakeSlackIdentity } from "../fakes/slack";

const NOW = Date.parse("2026-10-28T09:00:00Z");

/** A fake Slack whose tokens belong to `identity`, or else the fake's own workspace and app. */
function fakeSlack(identity?: Partial<FakeSlackIdentity>) {
  const slack = startFakeSlack({ now: () => NOW, identity });
  onTestFinished(() => slack.stop());
  return slack;
}

/**
 * Confirms `slack`'s tokens against `database` through a fresh bot client. `claim` claims their
 * Slack app, which no other app holds unless it says so.
 */
function confirm(
  database: BridgeDatabase,
  slack: FakeSlack,
  {
    tokens = { botToken: slack.botToken, appToken: slack.appToken },
    claim = () => null,
  }: {
    tokens?: { botToken: string; appToken: string };
    claim?: ClaimSlackApp;
  } = {},
) {
  const bot = createBotClient(slack.botToken, {
    slackApiUrl: slack.url,
    now: () => NOW,
  });
  return confirmIdentity(database, bot, tokens, claim);
}

/** The refusal of tokens whose `field` is `found` where the installation's is `stored`. */
function mismatch(
  field: Extract<IdentityRefusal, { reason: "mismatch" }>["field"],
  stored: string,
  found: string,
) {
  return { reason: "mismatch", field, stored, found } as const;
}

const fakeInstallation: Installation = {
  teamId: "TFAKE",
  enterpriseId: null,
  appId: "AFAKE",
  botId: "BFAKE",
  botUserId: "UFAKEBOT",
  status: "active",
};

describe("confirming the tokens", () => {
  test("an Enterprise workspace records its org, and the same tokens confirm again", async () => {
    const slack = fakeSlack({ enterpriseId: "EFAKE" });
    const database = await openTestDatabase();
    await confirm(database, slack);

    const installation = { ...fakeInstallation, enterpriseId: "EFAKE" };
    expect(await confirm(database, slack)).toMatchObject({ kind: "confirmed", installation });
    expect(await database.read(readInstallation)).toEqual(installation);
  });

  test("tokens from another workspace, app, bot, bot user or Enterprise org are refused, changing nothing", async () => {
    for (const [identity, refusal] of [
      [{ teamId: "TOTHER" }, mismatch("teamId", "TFAKE", "TOTHER")],
      [{ appId: "AOTHER" }, mismatch("appId", "AFAKE", "AOTHER")],
      [{ botId: "BOTHER" }, mismatch("botId", "BFAKE", "BOTHER")],
      [{ botUserId: "UOTHER" }, mismatch("botUserId", "UFAKEBOT", "UOTHER")],
      // A workspace that joined an Enterprise org since it was set up.
      [{ enterpriseId: "EFAKE" }, { reason: "moved_org" }],
    ] as const) {
      const database = await openTestDatabase();
      await confirm(database, fakeSlack());

      expect(await confirm(database, fakeSlack(identity))).toEqual({ kind: "refused", refusal });
      expect(await database.read(readInstallation)).toEqual(fakeInstallation);
    }
  });
});

describe("a Slack app another app the bridge hosts holds", () => {
  test("is refused even when this app's bridge.db records it too, which keeps the record", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    await confirm(database, slack);

    expect(await confirm(database, slack, { claim: () => "default" })).toEqual({
      kind: "refused",
      refusal: { reason: "duplicate_app", heldBy: "default" },
    });
    expect(await database.read(readInstallation)).toEqual(fakeInstallation);
  });

  test("is claimed only once the tokens match the installation, so a mismatch is refused as one", async () => {
    const database = await openTestDatabase();
    await confirm(database, fakeSlack());
    const claimed: string[] = [];
    const claim = (slackAppId: string) => {
      claimed.push(slackAppId);
      return "releases";
    };

    expect(await confirm(database, fakeSlack({ appId: "AOTHER" }), { claim })).toEqual({
      kind: "refused",
      refusal: mismatch("appId", "AFAKE", "AOTHER"),
    });
    expect(claimed).toEqual([]);
  });
});

describe("refusing credentials v1 doesn't support", () => {
  test("a rotating token is refused before Slack is asked", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    const tokens = { botToken: slack.botToken, appToken: `xoxe.${slack.appToken}` };

    expect(await confirm(database, slack, { tokens })).toEqual({
      kind: "refused",
      refusal: { reason: "rotating" },
    });
    expect(slack.calls).toEqual([]);
  });

  test("a token that expires, an org-wide install's or a user's is refused unrecorded", async () => {
    for (const [changes, refusal] of [
      [{ expires_in: 43_200 }, { reason: "rotating" }],
      [{ is_enterprise_install: true }, { reason: "org_wide" }],
      [{ bot_id: undefined }, { reason: "not_bot" }],
    ] as const) {
      const slack = fakeSlack();
      slack.setAuthResponse(changes);
      const database = await openTestDatabase();

      expect(await confirm(database, slack)).toEqual({ kind: "refused", refusal });
      expect(slack.calls.map(({ method }) => method)).toEqual(["auth.test"]);
      expect(await database.read(readInstallation)).toBeNull();
    }
  });
});

describe("reinstalling after an uninstall", () => {
  // Slack doesn't promise a reinstall keeps the bot's IDs.
  const newBot = { botId: "BNEW", botUserId: "UNEWBOT" };

  test("goes on with the bot Slack reports now, numbering where it was, given the same workspace, org and app", async () => {
    const database = await openTestDatabase();
    await confirm(database, fakeSlack({ enterpriseId: "EFAKE" }));
    const before = await createStoredRequest(database);
    await database.write(recordUninstall);

    const installation = { ...fakeInstallation, enterpriseId: "EFAKE", ...newBot };
    expect(await confirm(database, fakeSlack({ enterpriseId: "EFAKE", ...newBot }))).toMatchObject({
      kind: "confirmed",
      installation,
    });
    expect(await database.read(readInstallation)).toEqual(installation);
    expect((await createStoredRequest(database)).id).toBe(before.id + 1);
  });

  test("refuses another workspace, org or app, naming both, and a Slack app another app holds", async () => {
    for (const [identity, refusal] of [
      [{ teamId: "TOTHER" }, mismatch("teamId", "TFAKE", "TOTHER")],
      [{ appId: "AOTHER" }, mismatch("appId", "AFAKE", "AOTHER")],
      [{ enterpriseId: "EFAKE" }, { reason: "moved_org" }],
      [{}, { reason: "duplicate_app", heldBy: "default" }],
    ] as const) {
      const database = await openTestDatabase();
      await confirm(database, fakeSlack());
      await database.write(recordUninstall);
      const claim = () => (refusal.reason === "duplicate_app" ? refusal.heldBy : null);

      expect(await confirm(database, fakeSlack({ ...identity, ...newBot }), { claim })).toEqual({
        kind: "refused",
        refusal,
      });
      const uninstalled: Installation = { ...fakeInstallation, status: "uninstalled" };
      expect(await database.read(readInstallation)).toEqual(uninstalled);
    }
  });

  test("rejects a token Slack rejects, leaving the installation uninstalled", async () => {
    const slack = fakeSlack(newBot);
    const database = await openTestDatabase();
    await confirm(database, fakeSlack());
    await database.write(recordUninstall);
    slack.failNext("auth.test", { error: "token_revoked" });

    expect(await confirm(database, slack)).toEqual({ kind: "auth_failed", error: "token_revoked" });
    expect(await database.read(readInstallation)).toMatchObject({ status: "uninstalled" });
  });
});

describe("a rejected bot token", () => {
  test("decides nothing and leaves the installation as it was", async () => {
    for (const method of ["auth.test", "bots.info"]) {
      const slack = fakeSlack();
      const database = await openTestDatabase();
      await confirm(database, slack);
      slack.failNext(method, { error: "token_revoked" });

      expect(await confirm(database, slack)).toEqual({
        kind: "auth_failed",
        error: "token_revoked",
      });
      expect(await database.read(readInstallation)).toEqual(fakeInstallation);
    }
  });
});

describe("an answer the bridge can't get or read", () => {
  test("decides nothing, saying why and when Slack asked the bridge to wait", async () => {
    captureLog();
    const unreadable = (method: string) => `Slack didn't answer ${method}: unreadable response`;
    for (const [fail, detail, retryAt] of [
      [
        (slack) => slack.failNext("auth.test", { retryAfter: 30 }),
        "Slack is holding back auth.test",
        NOW + 30_000,
      ],
      [
        (slack) => slack.failNext("auth.test", { status: 503 }),
        "Slack didn't answer auth.test: HTTP 503",
        null,
      ],
      [
        (slack) => slack.failNext("bots.info", { error: "bot_not_found" }),
        "Slack refused bots.info with bot_not_found",
        null,
      ],
      [
        (slack) => slack.setBotResponse({ user_id: "UCONTRADICTION" }),
        "Slack's auth.test names bot user UFAKEBOT but bots.info UCONTRADICTION",
        null,
      ],
      [(slack) => slack.setAuthResponse({ team_id: 7 }), unreadable("auth.test"), null],
      [(slack) => slack.setBotResponse({ app_id: null }), unreadable("bots.info"), null],
      [(slack) => slack.failNext("auth.test", { body: "null" }), unreadable("auth.test"), null],
    ] as const satisfies readonly (readonly [
      (slack: FakeSlack) => void,
      string,
      number | null,
    ])[]) {
      const slack = fakeSlack();
      fail(slack);
      const database = await openTestDatabase();

      expect(await confirm(database, slack)).toEqual({ kind: "unavailable", detail, retryAt });
      expect(await database.read(readInstallation)).toBeNull();
    }
  });
});

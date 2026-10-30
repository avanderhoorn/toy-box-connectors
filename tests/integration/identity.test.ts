import { describe, expect, onTestFinished, test } from "bun:test";
import type { ClaimSlackApp } from "@bridge/model/claims";
import type { BridgeDatabase } from "@bridge/server/database";
import { confirmIdentity } from "@bridge/server/identity";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { Installation } from "@slackapi/model/installation";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack, type FakeSlack, type FakeSlackIdentity } from "../fakes/slack";

const NOW = Date.parse("2026-10-28T09:00:00Z");

/** A fake Slack whose tokens belong to `identity`, or else the fake's own workspace and app. */
function fakeSlack(identity?: Partial<FakeSlackIdentity>) {
  const slack = startFakeSlack({ now: () => NOW, identity });
  onTestFinished(() => slack.stop());
  return slack;
}

/**
 * Confirms `slack`'s tokens against `database` through a fresh bot client. `wrap` stands between the
 * check and the client, to steer a call. `claim` claims their Slack app, which no other app holds
 * unless it says so.
 */
function confirm(
  database: BridgeDatabase,
  slack: FakeSlack,
  {
    tokens = { botToken: slack.botToken, appToken: slack.appToken },
    wrap = (bot) => bot,
    claim = () => null,
  }: {
    tokens?: { botToken: string; appToken: string };
    wrap?: (bot: BotClient) => BotClient;
    claim?: ClaimSlackApp;
  } = {},
) {
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    now: () => NOW,
  });
  return confirmIdentity(database, wrap(bot), tokens, claim);
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
  test("the first answer records the installation the tokens belong to", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();

    expect(await confirm(database, slack)).toEqual({
      kind: "confirmed",
      installation: fakeInstallation,
      workspaceUrl: "https://fake-workspace.slack.com/",
    });
    expect(await database.read(readInstallation)).toEqual(fakeInstallation);
    expect(slack.calls.map(({ method, args }) => [method, args])).toEqual([
      ["auth.test", {}],
      ["bots.info", { bot: "BFAKE" }],
    ]);
  });

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
      [{ teamId: "TOTHER" }, { reason: "mismatch", field: "teamId", found: "TOTHER" }],
      [{ appId: "AOTHER" }, { reason: "mismatch", field: "appId", found: "AOTHER" }],
      [{ botId: "BOTHER" }, { reason: "mismatch", field: "botId", found: "BOTHER" }],
      [{ botUserId: "UOTHER" }, { reason: "mismatch", field: "botUserId", found: "UOTHER" }],
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
  test("is refused before anything is recorded, naming the app that holds it", async () => {
    const database = await openTestDatabase();
    const claimed: string[] = [];
    const claim = (slackAppId: string) => {
      claimed.push(slackAppId);
      return "releases";
    };

    expect(await confirm(database, fakeSlack(), { claim })).toEqual({
      kind: "refused",
      refusal: { reason: "duplicate_app", heldBy: "releases" },
    });
    expect(claimed).toEqual(["AFAKE"]);
    expect(await database.read(readInstallation)).toBeNull();
  });

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
      refusal: { reason: "mismatch", field: "appId", found: "AOTHER" },
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

  test("an uninstalled installation is refused without asking Slack", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    await createStoredInstallation(database, { status: "uninstalled" });

    expect(await confirm(database, slack)).toEqual({
      kind: "refused",
      refusal: { reason: "uninstalled" },
    });
    expect(slack.calls).toEqual([]);
  });

  test("an uninstall that commits while Slack is asked wins over the answer", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    await confirm(database, slack);
    const uninstalling = (bot: BotClient): BotClient => ({
      ...bot,
      async call(method, run) {
        const call = await bot.call(method, run);
        await database.write(
          (transaction) => transaction`UPDATE installation SET status = 'uninstalled'`,
        );
        return call;
      },
    });

    expect(await confirm(database, slack, { wrap: uninstalling })).toEqual({
      kind: "refused",
      refusal: { reason: "uninstalled" },
    });
    expect(await database.read(readInstallation)).toMatchObject({ status: "uninstalled" });
  });
});

describe("a rejected bot token", () => {
  test("fails the installation once Slack rejects it, until the tokens confirm again", async () => {
    for (const method of ["auth.test", "bots.info"]) {
      const slack = fakeSlack();
      const database = await openTestDatabase();
      await confirm(database, slack);
      slack.failNext(method, { error: "token_revoked" });

      expect(await confirm(database, slack)).toEqual({
        kind: "auth_failed",
        error: "token_revoked",
      });
      expect(await database.read(readInstallation)).toMatchObject({ status: "auth_failed" });

      expect(await confirm(database, fakeSlack({ teamId: "TOTHER" }))).toMatchObject({
        kind: "refused",
        refusal: { reason: "mismatch", field: "teamId" },
      });
      expect(await database.read(readInstallation)).toMatchObject({ status: "auth_failed" });

      expect(await confirm(database, slack)).toMatchObject({
        kind: "confirmed",
        installation: fakeInstallation,
      });
      expect(await database.read(readInstallation)).toEqual(fakeInstallation);
    }
  });
});

describe("an answer the bridge can't get or read", () => {
  test("decides nothing, saying why and when Slack asked the bridge to wait", async () => {
    const unreadable = (method: string) =>
      `Slack answered ${method} with something the bridge can't read`;
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

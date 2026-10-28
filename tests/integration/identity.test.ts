import { describe, expect, onTestFinished, test } from "bun:test";
import { interruptionGap } from "@activity/model/gaps";
import type { BridgeDatabase } from "@bridge/server/database";
import { confirmIdentity } from "@bridge/server/identity";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { Installation } from "@slackapi/model/installation";
import { createBotClient, guardBotClient, type BotClient } from "@slackapi/server/botClient";
import { markAuthFailed, readInstallation } from "@slackapi/server/installation";
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
 * check and the client, to steer a call.
 */
function confirm(
  database: BridgeDatabase,
  slack: FakeSlack,
  {
    tokens = { botToken: slack.botToken, appToken: slack.appToken },
    wrap = (bot) => bot,
  }: { tokens?: { botToken: string; appToken: string }; wrap?: (bot: BotClient) => BotClient } = {},
) {
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    now: () => NOW,
  });
  return confirmIdentity(database, wrap(bot), tokens, () => NOW);
}

function methodsCalled(slack: FakeSlack) {
  return slack.calls.map(({ method }) => method);
}

function readFailure(database: BridgeDatabase) {
  return database.read(async (sql) => {
    const [row] = await sql`SELECT status, auth_failed_at FROM installation`;
    return row;
  });
}

function readGaps(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT link_id, oldest_ts, latest_ts, reason FROM coverage ORDER BY id`,
  );
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
  test("a locally guarded identity check decides nothing about the installation", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    await createStoredInstallation(database);
    const before = await database.read(readInstallation);
    expect(
      await confirm(database, slack, { wrap: (bot) => guardBotClient(bot, () => false) }),
    ).toEqual({
      kind: "unavailable",
      detail: "The bridge cannot use Slack for auth.test right now",
      retryAt: null,
    });
    expect(methodsCalled(slack)).toEqual([]);
    expect(await database.read(readInstallation)).toEqual(before);
  });

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

  test("tokens from another workspace, app, bot or bot user are refused, changing nothing", async () => {
    for (const [field, found] of [
      ["teamId", "TOTHER"],
      ["appId", "AOTHER"],
      ["botId", "BOTHER"],
      ["botUserId", "UOTHER"],
    ] as const) {
      const database = await openTestDatabase();
      await confirm(database, fakeSlack());

      expect(await confirm(database, fakeSlack({ [field]: found }))).toEqual({
        kind: "refused",
        refusal: { reason: "mismatch", field, stored: fakeInstallation[field], found },
      });
      expect(await database.read(readInstallation)).toEqual(fakeInstallation);
    }
  });

  test("a workspace that joined an Enterprise org since it was set up is refused", async () => {
    const database = await openTestDatabase();
    await confirm(database, fakeSlack());

    expect(await confirm(database, fakeSlack({ enterpriseId: "EFAKE" }))).toEqual({
      kind: "refused",
      refusal: { reason: "moved_org", stored: null, found: "EFAKE" },
    });
    expect(await database.read(readInstallation)).toEqual(fakeInstallation);
  });
});

describe("refusing credentials v1 doesn't support", () => {
  test("a rotating token is refused before Slack is asked", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    const tokens = { botToken: slack.botToken, appToken: `xoxe.${slack.appToken}` };

    expect(await confirm(database, slack, { tokens })).toEqual({
      kind: "refused",
      refusal: { reason: "rotating", tokens: ["SLACK_APP_TOKEN"] },
    });
    expect(slack.calls).toEqual([]);
  });

  test("a token that expires, an org-wide install's or a user's is refused unrecorded", async () => {
    for (const [changes, refusal] of [
      [{ expires_in: 43_200 }, { reason: "rotating", tokens: ["SLACK_BOT_TOKEN"] }],
      [{ is_enterprise_install: true }, { reason: "org_wide" }],
      [{ bot_id: undefined }, { reason: "not_bot" }],
    ] as const) {
      const slack = fakeSlack();
      slack.setAuthResponse(changes);
      const database = await openTestDatabase();

      expect(await confirm(database, slack)).toEqual({ kind: "refused", refusal });
      expect(methodsCalled(slack)).toEqual(["auth.test"]);
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
  test("fails the installation from the moment Slack rejected it", async () => {
    for (const method of ["auth.test", "bots.info"]) {
      const slack = fakeSlack();
      const database = await openTestDatabase();
      await confirm(database, slack);
      slack.failNext(method, { error: "token_revoked" });

      expect(await confirm(database, slack)).toEqual({
        kind: "auth_failed",
        error: "token_revoked",
      });
      expect(await readFailure(database)).toEqual({ status: "auth_failed", auth_failed_at: NOW });
    }
  });

  test("recovers in the write that records the rejected span as a gap in every linked channel", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    await confirm(database, slack);
    await createStoredLink(database, "watch");
    await createStoredLink(database, "paused", { status: "paused" });
    await createStoredRequest(database, { linkId: "watch", channelId: "C-watch" });
    const failedAt = NOW - 3_600_000;
    await database.write((transaction) => markAuthFailed(transaction, failedAt));

    expect(await confirm(database, slack)).toMatchObject({
      kind: "confirmed",
      installation: fakeInstallation,
    });
    expect(await readFailure(database)).toEqual({ status: "active", auth_failed_at: null });
    const window = interruptionGap(failedAt, NOW, "1700000000.000100")!;
    expect(await readGaps(database)).toEqual(
      ["paused", "watch"].map((linkId) => ({
        link_id: linkId,
        oldest_ts: window.oldestTs,
        latest_ts: window.latestTs,
        reason: "auth_failed",
      })),
    );
    // An edit that came while the token was rejected was left for repair.
    expect(await database.read((sql) => sql`SELECT source_unverified_at FROM requests`)).toEqual([
      { source_unverified_at: NOW },
    ]);
  });

  test("records no gap when the installation wasn't failing", async () => {
    const slack = fakeSlack();
    const database = await openTestDatabase();
    await confirm(database, slack);
    await createStoredLink(database, "watch");

    expect(await confirm(database, slack)).toMatchObject({ kind: "confirmed" });
    expect(await readGaps(database)).toEqual([]);
  });

  test("keeps failing, recording nothing, while the tokens belong to someone else", async () => {
    const database = await openTestDatabase();
    await confirm(database, fakeSlack());
    await createStoredLink(database, "watch");
    await database.write((transaction) => markAuthFailed(transaction, NOW - 60_000));

    expect(await confirm(database, fakeSlack({ teamId: "TOTHER" }))).toMatchObject({
      kind: "refused",
      refusal: { reason: "mismatch", field: "teamId" },
    });
    expect(await readFailure(database)).toEqual({
      status: "auth_failed",
      auth_failed_at: NOW - 60_000,
    });
    expect(await readGaps(database)).toEqual([]);
  });
});

describe("an answer the bridge can't get or read", () => {
  test("decides nothing, saying when Slack asked the bridge to wait", async () => {
    for (const [method, failure, detail, retryAt] of [
      ["auth.test", { retryAfter: 30 }, "Slack is holding back auth.test", NOW + 30_000],
      ["auth.test", { status: 503 }, "Slack didn't answer auth.test: HTTP 503", null],
      ["bots.info", { error: "bot_not_found" }, "Slack refused bots.info with bot_not_found", null],
    ] as const) {
      const slack = fakeSlack();
      slack.failNext(method, failure);
      const database = await openTestDatabase();

      expect(await confirm(database, slack)).toEqual({ kind: "unavailable", detail, retryAt });
      expect(await database.read(readInstallation)).toBeNull();
    }
  });

  test("bots.info describing another bot user decides nothing", async () => {
    const slack = fakeSlack();
    slack.setBotResponse({ user_id: "UCONTRADICTION" });
    const database = await openTestDatabase();

    expect(await confirm(database, slack)).toEqual({
      kind: "unavailable",
      detail: "Slack's auth.test names bot user UFAKEBOT but bots.info UCONTRADICTION",
      retryAt: null,
    });
    expect(await database.read(readInstallation)).toBeNull();
  });

  test("an answer that isn't Slack's shape decides nothing", async () => {
    for (const [method, set] of [
      ["auth.test", (slack: FakeSlack) => slack.setAuthResponse({ team_id: 7 })],
      ["bots.info", (slack: FakeSlack) => slack.setBotResponse({ app_id: null })],
    ] as const) {
      const slack = fakeSlack();
      set(slack);
      const database = await openTestDatabase();

      expect(await confirm(database, slack)).toEqual({
        kind: "unavailable",
        detail: `Slack answered ${method} with something the bridge can't read`,
        retryAt: null,
      });
      expect(await database.read(readInstallation)).toBeNull();
    }
  });
});

import { expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import {
  fetchSlackPerson,
  readPersonIds,
  readSlackPersonName,
  writeSlackPerson,
} from "@slackapi/server/users";
import { startFakeSlack } from "../fakes/slack";

async function setup() {
  let at = 1000;
  const now = () => at;
  const slack = startFakeSlack({ now });
  onTestFinished(() => slack.stop());
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  const failed: string[] = [];
  const restart = () =>
    createBotClient(database, slack.botToken, {
      slackApiUrl: slack.url,
      timeoutMs: 50,
      now,
      onAuthFailed: (error) => failed.push(error),
    });
  return {
    slack,
    database,
    bot: restart(),
    restart,
    failed,
    advance: (ms: number) => {
      at += ms;
    },
  };
}
test("SDK retries cannot duplicate a post accepted before its response was lost", async () => {
  const { slack, bot } = await setup();
  const channel = slack.addChannel();
  slack.failNext("chat.postMessage", { lostResponse: true });
  expect(
    await bot.call("chat.postMessage", (client) =>
      client.chat.postMessage({ channel, text: "answer" }),
    ),
  ).toMatchObject({ kind: "unknown" });
  expect(slack.getMessages(channel)).toHaveLength(1);
  expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});
test("Retry-After holds only its method, and restarting can encounter one extra 429", async () => {
  const { slack, bot, restart, advance } = await setup();
  slack.failNext("auth.test", { retryAfter: 3 });
  expect(await bot.call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "rate_limited",
    until: 4000,
  });
  expect(await bot.call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "rate_limited",
    until: 4000,
  });
  expect(slack.calls).toHaveLength(1);
  const channel = slack.addChannel();
  expect(
    (await bot.call("conversations.info", (client) => client.conversations.info({ channel }))).kind,
  ).toBe("ok");
  slack.failNext("auth.test", { retryAfter: 3 });
  expect(await restart().call("auth.test", (client) => client.auth.test())).toEqual({
    kind: "rate_limited",
    until: 4000,
  });
  expect(slack.calls.filter((call) => call.method === "auth.test")).toHaveLength(2);
  advance(3000);
  expect((await bot.call("auth.test", (client) => client.auth.test())).kind).toBe("ok");
});
test("token failures persist and notify once, even across clients", async () => {
  const { slack, restart, failed } = await setup();
  for (let n = 0; n < 2; n++) {
    slack.failNext("auth.test", { error: "invalid_auth" });
    expect((await restart().call("auth.test", (client) => client.auth.test())).kind).toBe(
      "auth_failed",
    );
  }
  expect(failed).toEqual(["invalid_auth"]);
});
test("fresh users.info binds Enterprise aliases to stored names, not cached admission", async () => {
  const { slack, database, bot } = await setup();
  slack.setUser(
    {
      id: "UALICE",
      team_id: "TFAKE",
      enterprise_user: { id: "WALICE", enterprise_id: "EORG" },
      is_bot: false,
      is_restricted: false,
      is_ultra_restricted: false,
      profile: { real_name: "Alice Smith", display_name: "Alice" },
    },
    ["WALICE"],
  );
  const facts = await bot.call("users.info", (client) => fetchSlackPerson(client, "WALICE"));
  if (facts.kind !== "ok" || facts.result === null) throw new Error("Expected fresh user facts");
  await database.write((tx) => writeSlackPerson(tx, facts.result!));
  expect(await database.read((sql) => readPersonIds(sql, "WALICE"))).toEqual(["UALICE", "WALICE"]);
  expect(await database.read((sql) => readSlackPersonName(sql, "WALICE"))).toBe("Alice Smith");
});

import { expect, onTestFinished, test } from "bun:test";
import { captureLog, openTestDatabase } from "@bridge/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { captureConsole, createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../fakes/slack";

/** How Slack explains blocks it can't accept, which names where they went wrong. */
const BLOCKS_FAULT = "[ERROR] failed to match all allowed schemas [json-pointer:/blocks/0/text]";

async function setup() {
  let at = 1000;
  const now = () => at;
  const slack = startFakeSlack({ now });
  onTestFinished(() => slack.stop());
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  const restart = () =>
    createBotClient(database, slack.botToken, {
      slackApiUrl: slack.url,
      timeoutMs: 50,
      now,
    });
  return {
    slack,
    bot: restart(),
    restart,
    advance: (ms: number) => {
      at += ms;
    },
  };
}
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
test("the SDK prints nothing, even Slack's explanation of what was wrong with a request", async () => {
  const { slack, bot } = await setup();
  captureLog();
  const printed = captureConsole();
  const channel = slack.addChannel();
  slack.failNext("chat.postMessage", { error: "invalid_blocks", messages: [BLOCKS_FAULT] });
  expect(
    await bot.call("chat.postMessage", (client) =>
      client.chat.postMessage({ channel, text: "answer" }),
    ),
  ).toMatchObject({ kind: "error", error: "invalid_blocks" });
  expect(printed()).toEqual([]);
});
test("logs the method and code of a request Slack found fault with, and no other refusal", async () => {
  const { slack, bot } = await setup();
  const logged = captureLog();
  const channel = slack.addChannel();
  const post = () =>
    bot.call("chat.postMessage", (client) => client.chat.postMessage({ channel, text: "answer" }));
  slack.failNext("chat.postMessage", { error: "not_in_channel" });
  expect(await post()).toMatchObject({ kind: "error", error: "not_in_channel" });
  slack.failNext("chat.postMessage", { error: "invalid_blocks", messages: [BLOCKS_FAULT] });
  expect(await post()).toMatchObject({ kind: "error", error: "invalid_blocks" });
  expect(logged()).toEqual(["Slack refused chat.postMessage with invalid_blocks."]);
});

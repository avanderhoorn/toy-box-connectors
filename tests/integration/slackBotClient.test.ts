import { expect, onTestFinished, test } from "bun:test";
import { captureLog } from "@bridge/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { fetchHistoryPage } from "@slackapi/server/history";
import { captureConsole, nonJsonAnswers, unreadableAnswers } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../fakes/slack";

/** How Slack explains blocks it can't accept, which names where they went wrong. */
const BLOCKS_FAULT = "[ERROR] failed to match all allowed schemas [json-pointer:/blocks/0/text]";

async function setup(token?: string) {
  let at = 1000;
  const now = () => at;
  const slack = startFakeSlack({ now });
  onTestFinished(() => slack.stop());
  const restart = () =>
    createBotClient(token ?? slack.botToken, {
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
test.each(unreadableAnswers)(
  "an answer that %s is no answer, as a lost one is",
  async (_, body) => {
    const { slack, bot } = await setup();
    captureLog();
    const channelId = slack.addChannel();
    slack.failNext("conversations.history", { body });
    expect(
      await bot.call("conversations.history", (client) =>
        fetchHistoryPage(client, { channelId, oldest: "0", cursor: null }),
      ),
    ).toEqual({ kind: "unknown", detail: "unreadable response" });
  },
);
test.each(nonJsonAnswers)(
  "an answer that %s is unreadable, with no error code or method cooldown",
  async (_, body) => {
    const { slack, bot } = await setup();
    const logged = captureLog();
    const channelId = slack.addChannel();
    const read = () =>
      bot.call("conversations.history", (client) =>
        fetchHistoryPage(client, { channelId, oldest: "0", cursor: null }),
      );
    slack.failNext("conversations.history", { body });
    expect(await read()).toEqual({ kind: "unknown", detail: "unreadable response" });
    expect(logged()).toEqual([
      "Couldn't read Slack's answer to conversations.history: the answer isn't JSON.",
    ]);
    expect((await read()).kind).toBe("ok");
  },
);
test.each([
  { messages: [7] },
  { messages: "The staging password is hunter2" },
  { retryAfter: "later" },
  { retryAfter: -1 },
])("unreadable error metadata is no answer: %j", async (metadata) => {
  const { slack, bot } = await setup();
  const logged = captureLog();
  const channelId = slack.addChannel();
  const body = JSON.stringify({
    ok: false,
    error: "ratelimited",
    response_metadata: metadata,
  });
  slack.failNext("conversations.history", { body });
  expect(
    await bot.call("conversations.history", (client) =>
      fetchHistoryPage(client, { channelId, oldest: "0", cursor: null }),
    ),
  ).toEqual({ kind: "unknown", detail: "unreadable response" });
  expect(logged()).toEqual([
    "Couldn't read Slack's answer to conversations.history: unreadable response.",
  ]);
});
test("logs the method and what didn't parse in an answer, never what it said", async () => {
  const { slack, bot } = await setup();
  const logged = captureLog();
  const channelId = slack.addChannel();
  const read = () =>
    bot.call("conversations.history", (client) =>
      fetchHistoryPage(client, { channelId, oldest: "0", cursor: null }),
    );
  const said = "The staging password is hunter2";
  slack.failNext("conversations.history", { body: JSON.stringify({ ok: true, messages: said }) });
  await read();
  slack.failNext("conversations.history", { body: JSON.stringify(said) });
  await read();
  expect(logged()).toEqual([
    "Couldn't read Slack's answer to conversations.history: invalid_type at messages.",
    "Couldn't read Slack's answer to conversations.history: the Slack SDK failed on it.",
  ]);
});
test("an error in the bridge's own code is thrown on, unlogged", async () => {
  const { bot } = await setup();
  const logged = captureLog();
  const bug = new TypeError("undefined is not an object");
  await expect(
    bot.call("auth.test", async (client) => {
      await client.auth.test();
      throw bug;
    }),
  ).rejects.toBe(bug);
  expect(logged()).toEqual([]);
});
test("a download Slack sends to sign in is refused, not followed", async () => {
  const { slack, bot } = await setup("xoxb-revoked");
  const file = slack.addFile("Release notes", { user: "UALICE" });
  // Following it would reach the fake's sign-in page, a route it fails the test for when it stops.
  expect(await bot.download({ url: file.url_private_download, size: file.size })).toEqual({
    kind: "refused",
    reason: "Slack answered with HTTP 302",
  });
});

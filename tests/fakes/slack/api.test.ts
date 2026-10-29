import { expect, onTestFinished, test } from "bun:test";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import { startFakeSlack, type FakeSlackApp } from "./index";

const messagePage = z.object({
  messages: z.array(z.object({ ts: z.string() })),
  has_more: z.boolean(),
  response_metadata: z.object({ next_cursor: z.string() }),
});

function setup(options?: Parameters<typeof startFakeSlack>[0]) {
  const fake = startFakeSlack(options);
  onTestFinished(() => fake.stop());
  return { fake, client: botClient(fake) };
}

function botClient(app: FakeSlackApp) {
  return new WebClient(app.botToken, {
    slackApiUrl: app.url,
    timeout: 1000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
  });
}

test("opaque cursors preserve exact decimal bounds through empty pages and reject a different query", async () => {
  const { fake, client } = setup({ pageSize: 1 });
  const channel = fake.addChannel();
  const timestamps = [
    "9007199254740993.000001",
    "9007199254740993.000002",
    "9007199254740993.000003",
  ];
  for (const ts of timestamps) fake.setMessage(channel, { ts });
  const query = { channel, oldest: timestamps[0], latest: timestamps[2] };
  expect((await client.conversations.history(query)).messages?.map(({ ts }) => ts)).toEqual([
    timestamps[1],
  ]);
  fake.emptyNextPage("conversations.history");
  const pages = [];
  for await (const page of client.paginate("conversations.history", { ...query, inclusive: true }))
    pages.push(messagePage.parse(page));
  expect(pages).toHaveLength(4);
  expect(pages[0]).toMatchObject({ messages: [], has_more: true });
  expect(pages.flatMap((page) => page.messages ?? []).map(({ ts }) => ts)).toEqual(
    timestamps.toReversed(),
  );
  expect(pages.at(-1)).toMatchObject({ response_metadata: { next_cursor: "" } });
  await expect(
    client.conversations.history({
      ...query,
      channel: fake.addChannel(),
      inclusive: true,
      cursor: pages[0]!.response_metadata?.next_cursor,
    }),
  ).rejects.toMatchObject({ data: { error: "invalid_cursor" } });
});

test("unknown methods, arguments and malformed JSON fail cleanup even with a fault queued", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  fake.failNext("conversations.history", { error: "not_in_channel" });
  await expect(
    client.apiCall("conversations.history", { channel, oldset: "1.000001" }),
  ).rejects.toMatchObject({ data: { error: "invalid_arguments" } });
  await expect(client.conversations.history({ channel })).rejects.toMatchObject({
    data: { error: "not_in_channel" },
  });
  await expect(client.apiCall("imaginary.success", {})).rejects.toMatchObject({
    data: { error: "invalid_arguments" },
  });
  await expect(
    client.apiCall("chat.postMessage", { channel, text: "Bad", blocks: "not JSON" }),
  ).rejects.toMatchObject({ data: { error: "invalid_arguments" } });
  await expect(fake.stop()).rejects.toThrow("Unexpected fake Slack traffic");
});

test("writes keep unique timestamps and bot-only deletion", async () => {
  const { fake, client } = setup({ now: () => 1000 });
  const channel = fake.addChannel();
  fake.setMessage(channel, {
    ts: "1.000000",
    user: "UOTHER",
  });
  await expect(client.chat.delete({ channel, ts: "1.000000" })).rejects.toMatchObject({
    data: { error: "cant_delete_message" },
  });
  expect((await client.chat.postMessage({ channel, text: "First" })).ts).toBe("1.000001");
  const second = await client.chat.postMessage({ channel, text: "Second" });
  expect(second.ts).toBe("1.000002");
  await client.chat.delete({ channel, ts: second.ts! });
  expect(fake.getMessages(channel).map(({ ts }) => ts)).toEqual(["1.000000", "1.000001"]);
});

test("tokens select each app's installation and failures without mixing workspaces", async () => {
  const { fake, client } = setup({ pageSize: 1 });
  const other = fake.addApp();
  const elsewhere = fake.addApp({ teamId: "TOTHER", enterpriseId: "EOTHER" });
  for (const app of [fake, other, elsewhere]) {
    const bot = botClient(app);
    expect(await bot.auth.test()).toMatchObject({
      team_id: app.identity.teamId,
      user_id: app.identity.botUserId,
      bot_id: app.identity.botId,
    });
    expect((await bot.bots.info({ bot: app.identity.botId })).bot).toMatchObject({
      app_id: app.identity.appId,
      user_id: app.identity.botUserId,
      id: app.identity.botId,
    });
  }
  fake.setUser({ id: "UALICE", name: "alice" });
  expect((await botClient(other).users.info({ user: "UALICE" })).user?.name).toBe("alice");
  await expect(botClient(elsewhere).users.info({ user: "UALICE" })).rejects.toMatchObject({
    data: { error: "user_not_found" },
  });
  other.setAuthResponse({ is_enterprise_install: true });
  other.failNext("auth.test", { error: "token_revoked" });
  expect((await client.auth.test()).is_enterprise_install).toBe(false);
  await expect(botClient(other).auth.test()).rejects.toMatchObject({
    data: { error: "token_revoked" },
  });
  expect((await botClient(other).auth.test()).is_enterprise_install).toBe(true);
  const channel = fake.addChannel();
  other.addChannel({ id: channel });
  for (const ts of ["1.000001", "1.000002"]) fake.setMessage(channel, { ts });
  const page = await client.conversations.history({ channel });
  expect(page.response_metadata?.next_cursor).toBeTruthy();
  await expect(
    botClient(other).conversations.history({
      channel,
      cursor: page.response_metadata!.next_cursor,
    }),
  ).rejects.toMatchObject({ data: { error: "invalid_cursor" } });
});

test("apps share messages but keep membership, authorship, reactions and deletion authority", async () => {
  const { fake, client } = setup({ now: () => 1000 });
  const other = fake.addApp();
  const second = botClient(other);
  const channel = fake.addChannel({ is_private: true });
  await expect(second.conversations.info({ channel })).rejects.toMatchObject({
    data: { error: "channel_not_found" },
  });
  other.addChannel({ id: channel });
  expect((await second.conversations.info({ channel })).channel?.is_private).toBe(true);
  const first = await client.chat.postMessage({ channel, text: "A" });
  const reply = await second.chat.postMessage({ channel, text: "B", thread_ts: first.ts! });
  expect([first.ts, reply.ts]).toEqual(["1.000000", "1.000001"]);
  for (const [app, receipt] of [
    [fake, first],
    [other, reply],
  ] as const) {
    expect(receipt.message).toMatchObject({
      user: app.identity.botUserId,
      bot_id: app.identity.botId,
      app_id: app.identity.appId,
    });
    expect(fake.getMessages(channel).find(({ ts }) => ts === receipt.ts)).toMatchObject(
      receipt.message!,
    );
  }
  expect(
    (await second.conversations.replies({ channel, ts: first.ts! })).messages?.map(({ ts }) => ts),
  ).toEqual([first.ts, reply.ts]);
  for (const bot of [client, second])
    await bot.reactions.add({ channel, timestamp: first.ts!, name: "eyes" });
  expect(fake.getMessages(channel)[0]!.reactions).toEqual([
    { name: "eyes", count: 2, users: [fake.identity.botUserId, other.identity.botUserId] },
  ]);
  await expect(second.chat.delete({ channel, ts: first.ts! })).rejects.toMatchObject({
    data: { error: "cant_delete_message" },
  });
  await second.chat.delete({ channel, ts: reply.ts! });
  fake.addChannel({ id: channel, is_member: false });
  expect((await client.conversations.info({ channel })).channel?.is_member).toBe(false);
  expect((await second.conversations.info({ channel })).channel?.is_member).toBe(true);
  await expect(client.conversations.history({ channel })).rejects.toMatchObject({
    data: { error: "not_in_channel" },
  });
  expect((await second.conversations.history({ channel })).messages?.map(({ ts }) => ts)).toEqual([
    first.ts,
  ]);
});

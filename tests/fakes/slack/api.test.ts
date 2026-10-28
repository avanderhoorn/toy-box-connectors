import { expect, onTestFinished, test } from "bun:test";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import { startFakeSlack } from "./index";

const messagePage = z.object({
  messages: z.array(z.object({ ts: z.string() })),
  has_more: z.boolean(),
  response_metadata: z.object({ next_cursor: z.string() }),
});

function setup(options?: Parameters<typeof startFakeSlack>[0]) {
  const fake = startFakeSlack(options);
  onTestFinished(() => fake.stop());
  const client = new WebClient(fake.botToken, {
    slackApiUrl: fake.url,
    timeout: 1000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
  });
  return { fake, client };
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

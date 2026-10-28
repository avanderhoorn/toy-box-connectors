import { expect, onTestFinished, test } from "bun:test";
import { ErrorCode, LogLevel, WebClient } from "@slack/web-api";
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

test("auth.test and bots.info agree with the installed identity and expose the scopes header", async () => {
  const { fake, client } = setup({
    identity: { teamId: "T1", enterpriseId: "E1", botUserId: "W1", botId: "B1", appId: "A1" },
    scopes: ["chat:write", "users:read"],
  });
  const auth = await client.auth.test();
  expect(auth).toMatchObject({
    team_id: "T1",
    enterprise_id: "E1",
    user_id: "W1",
    bot_id: "B1",
    is_enterprise_install: false,
    response_metadata: { scopes: ["chat:write", "users:read"] },
  });
  expect(Object.hasOwn(auth, "app_id")).toBe(false);
  expect(await client.bots.info({ bot: "B1" })).toMatchObject({
    bot: { id: "B1", user_id: "W1", app_id: "A1" },
  });
  fake.setBotResponse({ user_id: "UCONTRADICTION" });
  expect((await client.bots.info({ bot: "B1" })).bot?.user_id).toBe("UCONTRADICTION");
  fake.setAuthResponse({ expires_in: 43200, is_enterprise_install: true });
  expect(await client.auth.test()).toMatchObject({
    expires_in: 43200,
    is_enterprise_install: true,
  });
  await expect(client.bots.info({ bot: "BOTHER" })).rejects.toMatchObject({
    data: { error: "bot_not_found" },
  });
});

test("users.info preserves Enterprise aliases, guest flags and absent deleted without repairing them", async () => {
  const { fake, client } = setup({ identity: { enterpriseId: "E1" } });
  const person = {
    id: "ULOCAL",
    team_id: "TSIBLING",
    is_bot: false,
    is_restricted: true,
    enterprise_user: { id: "WGLOBAL", enterprise_id: "E1", teams: ["TSIBLING"] },
    profile: { display_name: "Colleague", real_name: "A Colleague" },
  };
  fake.setUser(person, ["UOLD"]);
  for (const user of ["ULOCAL", "WGLOBAL", "UOLD"])
    expect((await client.users.info({ user })).user).toEqual(person);
  fake.setUser({ ...person, deleted: true });
  expect((await client.users.info({ user: "WGLOBAL" })).user?.deleted).toBe(true);
  fake.setUser({ id: "UFOREIGN", enterprise_user: { id: "WFOREIGN", enterprise_id: "EOTHER" } });
  expect((await client.users.info({ user: "WFOREIGN" })).user?.enterprise_user?.enterprise_id).toBe(
    "EOTHER",
  );
  await expect(client.users.info({ user: "UUNKNOWN" })).rejects.toMatchObject({
    data: { error: "user_not_found" },
  });
});

test("channel info preserves internal sharing and supports raw missing fields", async () => {
  const { fake, client } = setup({ identity: { enterpriseId: "E1" } });
  const channel = fake.addChannel({
    id: "C1",
    is_org_shared: true,
    is_shared: true,
    shared_team_ids: ["T2", "T1"],
  });
  fake.setMembers(channel, [fake.identity.botUserId, "WOWNER"]);
  expect(
    (await client.conversations.info({ channel, include_num_members: true })).channel,
  ).toMatchObject({
    is_org_shared: true,
    is_ext_shared: false,
    enterprise_id: "E1",
    shared_team_ids: ["T2", "T1"],
    num_members: 2,
  });
  fake.setChannel({ id: channel, is_org_shared: true });
  expect((await client.conversations.info({ channel })).channel).toEqual({
    id: channel,
    is_org_shared: true,
  });
  expect((await client.conversations.members({ channel })).members).toEqual([
    fake.identity.botUserId,
    "WOWNER",
  ]);
});

test("history omits ordinary replies, while replies returns its root and children oldest first", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  for (const message of [
    { ts: "100.000001", text: "Root", user: "U1" },
    { ts: "100.000002", text: "Another root" },
    { ts: "100.000003", text: "Reply", thread_ts: "100.000001" },
    { ts: "100.000004", text: "Broadcast", thread_ts: "100.000001", subtype: "thread_broadcast" },
  ])
    fake.setMessage(channel, message);
  const history = await client.conversations.history({ channel });
  expect(history.messages?.map(({ ts }) => ts)).toEqual(["100.000004", "100.000002", "100.000001"]);
  expect(history.messages?.at(-1)).toMatchObject({
    reply_count: 2,
    thread_ts: "100.000001",
    latest_reply: "100.000004",
  });
  const replies = await client.conversations.replies({ channel, ts: "100.000001" });
  expect(replies.messages?.map(({ ts }) => ts)).toEqual(["100.000001", "100.000003", "100.000004"]);
  expect((await client.conversations.replies({ channel, ts: "100.000003" })).messages).toEqual(
    replies.messages,
  );
});

test("real SDK pagination follows an empty page and opaque cursors without losing query bounds", async () => {
  const { fake, client } = setup({ pageSize: 1 });
  const channel = fake.addChannel();
  for (const ts of ["100.000001", "100.000002", "100.000003"]) fake.setMessage(channel, { ts });
  fake.emptyNextPage("conversations.history");
  const pages = [];
  for await (const page of client.paginate("conversations.history", {
    channel,
    limit: 2,
    oldest: "100.000001",
    latest: "100.000003",
    inclusive: true,
  }))
    pages.push(messagePage.parse(page));
  expect(pages).toHaveLength(4);
  expect(pages[0]).toMatchObject({ messages: [], has_more: true });
  expect(pages.at(-1)).toMatchObject({ has_more: false, response_metadata: { next_cursor: "" } });
  expect(pages.flatMap((page) => page.messages ?? []).map((message) => message.ts)).toEqual([
    "100.000003",
    "100.000002",
    "100.000001",
  ]);
  expect(
    fake.calls
      .slice(1)
      .every(
        (call) =>
          call.args.oldest === "100.000001" &&
          call.args.latest === "100.000003" &&
          typeof call.args.cursor === "string",
      ),
  ).toBe(true);
});

test("thread pagination is chronological and can begin with an empty page", async () => {
  const { fake, client } = setup({ pageSize: 1 });
  const channel = fake.addChannel();
  fake.setMessage(channel, { ts: "1.000001" });
  fake.setMessage(channel, { ts: "2.000001", thread_ts: "1.000001" });
  fake.emptyNextPage("conversations.replies");
  const pages = [];
  for await (const page of client.paginate("conversations.replies", { channel, ts: "1.000001" }))
    pages.push(messagePage.parse(page));
  expect(pages).toHaveLength(3);
  expect(pages.flatMap((page) => page.messages ?? []).map((message) => message.ts)).toEqual([
    "1.000001",
    "2.000001",
  ]);
});

test("time bounds are exclusive unless inclusive, and timestamps never pass through floating point", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  const timestamps = [
    "9007199254740993.000001",
    "9007199254740993.000002",
    "9007199254740993.000003",
  ];
  for (const ts of timestamps) fake.setMessage(channel, { ts });
  const args = { channel, oldest: timestamps[0], latest: timestamps[2] };
  expect((await client.conversations.history(args)).messages?.map(({ ts }) => ts)).toEqual([
    timestamps[1],
  ]);
  expect(
    (await client.conversations.history({ ...args, inclusive: true })).messages?.map(
      ({ ts }) => ts,
    ),
  ).toEqual(timestamps.toReversed());
  fake.setMessage(channel, { ts: "1.1" });
  expect(
    (await client.conversations.history({ channel, oldest: "1.10", latest: "1.100" })).messages,
  ).toEqual([]);
});

test("cursor scope, missing channels, membership and missing thread failures stay explicit", async () => {
  const { fake, client } = setup({ pageSize: 1 });
  const channel = fake.addChannel();
  const other = fake.addChannel();
  for (const ts of ["1.000001", "2.000001"]) fake.setMessage(channel, { ts });
  const first = await client.conversations.history({ channel });
  await expect(
    client.conversations.history({ channel: other, cursor: first.response_metadata?.next_cursor }),
  ).rejects.toMatchObject({ data: { error: "invalid_cursor" } });
  await expect(client.conversations.replies({ channel, ts: "99.000001" })).rejects.toMatchObject({
    data: { error: "thread_not_found" },
  });
  await expect(client.conversations.history({ channel: "CMISSING" })).rejects.toMatchObject({
    data: { error: "channel_not_found" },
  });
  fake.setMembers(channel, []);
  await expect(client.conversations.history({ channel })).rejects.toMatchObject({
    data: { error: "not_in_channel" },
  });
});

test("lists paginate channel visibility and unique user profiles, not aliases", async () => {
  const { fake, client } = setup({ pageSize: 1 });
  fake.addChannel({ id: "CPUBLIC" });
  fake.addChannel({ id: "CPRIVATE", is_private: true });
  fake.addChannel({ id: "CINACCESSIBLE", is_private: true, is_member: false });
  fake.setUser({ id: "ULOCAL", enterprise_user: { id: "WGLOBAL", enterprise_id: "E1" } });
  const channels = [];
  for await (const page of client.paginate("conversations.list", {
    types: "public_channel,private_channel",
  }))
    channels.push(
      ...z.object({ channels: z.array(z.object({ id: z.string() })) }).parse(page).channels,
    );
  expect(channels.map(({ id }) => id)).toEqual(["CPUBLIC", "CPRIVATE"]);
  const users = [];
  for await (const page of client.paginate("users.list", {}))
    users.push(...z.object({ members: z.array(z.object({ id: z.string() })) }).parse(page).members);
  expect(users.map(({ id }) => id)).toEqual([fake.identity.botUserId, "ULOCAL"]);
});

test("read failures are HTTP-200 Slack errors and 429 applies only to its injected method", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  fake.failNext("conversations.history", { error: "ekm_access_denied" });
  await expect(client.conversations.history({ channel })).rejects.toMatchObject({
    code: ErrorCode.PlatformError,
    data: { error: "ekm_access_denied" },
  });
  fake.failNext("conversations.history", { retryAfter: 3 });
  expect((await client.conversations.info({ channel })).ok).toBe(true);
  await expect(client.conversations.history({ channel })).rejects.toMatchObject({
    code: ErrorCode.RateLimitedError,
    retryAfter: 3,
  });
  expect(fake.calls.filter(({ method }) => method === "conversations.history")).toHaveLength(2);
});

test("unexpected read arguments fail even when a platform failure was queued", async () => {
  const { fake, client } = setup();
  fake.failNext("conversations.history", { error: "missing_scope" });
  await expect(
    client.apiCall("conversations.history", { channel: "C1", oldset: "1.000001" }),
  ).rejects.toMatchObject({ data: { error: "invalid_arguments" } });
  await expect(fake.stop()).rejects.toThrow("oldset");
});

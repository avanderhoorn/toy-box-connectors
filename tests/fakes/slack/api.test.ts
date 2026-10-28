import { expect, onTestFinished, test } from "bun:test";
import { ErrorCode, LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import { startFakeSlack } from "./index";

const messagePage = z.object({
  messages: z.array(z.object({ ts: z.string() })),
  has_more: z.boolean(),
  response_metadata: z.object({ next_cursor: z.string() }),
});

function setup(options?: Parameters<typeof startFakeSlack>[0], timeout = 1000, retries = 0) {
  const fake = startFakeSlack(options);
  onTestFinished(() => fake.stop());
  const client = new WebClient(fake.botToken, {
    slackApiUrl: fake.url,
    timeout,
    retryConfig: { retries, minTimeout: 1, maxTimeout: 1, randomize: false },
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

test("the default scopes header matches the canonical Slack manifest", async () => {
  const { client } = setup();
  const manifest = z
    .object({ oauth_config: z.object({ scopes: z.object({ bot: z.array(z.string()) }) }) })
    .parse(
      Bun.YAML.parse(
        await Bun.file(new URL("../../../docs/manifest.yaml", import.meta.url)).text(),
      ),
    );
  const result = await client.auth.test();
  expect(result.response_metadata?.scopes?.toSorted()).toEqual(
    manifest.oauth_config.scopes.bot.toSorted(),
  );
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
  expect((await client.users.info({ user: "UOLD" })).user?.deleted).toBe(true);
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

test("posting parses SDK JSON fields and preserves bot identity, thread and reconciliation metadata", async () => {
  const { fake, client } = setup({ now: () => 1_700_000_000_000 });
  const channel = fake.addChannel();
  fake.setMessage(channel, { ts: "1.000001", user: "U1", text: "Question" });
  const metadata = {
    event_type: "toy_box_outbox",
    event_payload: { id: "outbox", payload_hash: "hash" },
  };
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Answer*" } }];
  const post = await client.chat.postMessage({
    channel,
    thread_ts: "1.000001",
    text: "Answer",
    blocks,
    metadata,
    unfurl_links: false,
    unfurl_media: false,
    parse: "none",
  });
  expect(post.message).toMatchObject({
    ts: "1700000000.000000",
    text: "Answer",
    thread_ts: "1.000001",
    blocks,
    metadata,
    user: fake.identity.botUserId,
    bot_id: fake.identity.botId,
    app_id: fake.identity.appId,
  });
  expect((await client.conversations.history({ channel })).messages).toHaveLength(1);
  const replies = await client.conversations.replies({
    channel,
    ts: "1.000001",
    include_all_metadata: true,
  });
  expect(replies.messages?.[1].metadata).toEqual(metadata);
  const minimal = await client.conversations.replies({ channel, ts: "1.000001" });
  expect(minimal.messages?.[1].metadata).toEqual({ event_type: "toy_box_outbox" });
});

test("updates retain blocks and metadata when omitted, remove blocks with text, and honor explicit empty fields", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  const blocks = [{ type: "section", text: { type: "plain_text", text: "Card" } }];
  const metadata = { event_type: "toy_box_outbox", event_payload: { id: "a1" } };
  const post = await client.chat.postMessage({ channel, text: "Card", blocks, metadata });
  // Slack documents metadata-only updates and {} deletion; the SDK's method types reject both.
  await client.apiCall("chat.update", {
    channel,
    ts: post.ts!,
    metadata: { ...metadata, event_payload: { id: "a2" } },
  });

  expect(fake.getMessages(channel)[0]).toMatchObject({
    blocks,
    metadata: { event_payload: { id: "a2" } },
  });
  await client.chat.update({ channel, ts: post.ts!, text: "Changed" });
  expect(fake.getMessages(channel)[0].blocks).toBeUndefined();
  expect(fake.getMessages(channel)[0].metadata).toBeDefined();
  await client.apiCall("chat.update", { channel, ts: post.ts!, blocks, metadata: {} });
  expect(fake.getMessages(channel)[0].metadata).toBeUndefined();
  await client.chat.update({ channel, ts: post.ts!, blocks: [] });
  expect(fake.getMessages(channel)[0].blocks).toBeUndefined();
});

test("posts remain unique with a frozen clock and a seeded message at the current microsecond", async () => {
  const { fake, client } = setup({ now: () => 1000 });
  const channel = fake.addChannel();
  fake.setMessage(channel, { ts: "1.000000", user: "U1", text: "Existing" });
  expect((await client.chat.postMessage({ channel, text: "First" })).ts).toBe("1.000001");
  expect((await client.chat.postMessage({ channel, text: "Second" })).ts).toBe("1.000002");
  expect(fake.getMessages(channel).map(({ text }) => text)).toEqual([
    "Existing",
    "First",
    "Second",
  ]);
});

test("delete removes only the named bot post and foreign messages cannot be edited or deleted", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  fake.setMessage(channel, { ts: "1.000001", user: "UOTHER", text: "Not ours" });
  await expect(
    client.chat.update({ channel, ts: "1.000001", text: "Changed" }),
  ).rejects.toMatchObject({ data: { error: "cant_update_message" } });
  await expect(client.chat.delete({ channel, ts: "1.000001" })).rejects.toMatchObject({
    data: { error: "cant_delete_message" },
  });
  const post = await client.chat.postMessage({ channel, text: "Ours" });
  await client.chat.delete({ channel, ts: post.ts! });
  expect(fake.getMessages(channel).map(({ ts }) => ts)).toEqual(["1.000001"]);
  await expect(client.chat.delete({ channel, ts: post.ts! })).rejects.toMatchObject({
    data: { error: "message_not_found" },
  });
});

test("reactions preserve other users and duplicate adds/removes return Slack errors", async () => {
  const { fake, client } = setup({ emojiNames: ["custom_status"] });
  const channel = fake.addChannel();
  fake.setMessage(channel, {
    ts: "1.000001",
    reactions: [{ name: "eyes", users: ["UOTHER"], count: 1 }],
  });
  const args = { channel, timestamp: "1.000001", name: "eyes" };
  await client.reactions.add(args);
  expect(fake.getMessages(channel)[0].reactions).toEqual([
    { name: "eyes", users: ["UOTHER", fake.identity.botUserId], count: 2 },
  ]);
  await expect(client.reactions.add(args)).rejects.toMatchObject({
    data: { error: "already_reacted" },
  });
  await client.reactions.remove(args);
  expect(fake.getMessages(channel)[0].reactions).toEqual([
    { name: "eyes", users: ["UOTHER"], count: 1 },
  ]);
  await expect(client.reactions.remove(args)).rejects.toMatchObject({
    data: { error: "no_reaction" },
  });
  await expect(client.reactions.add({ ...args, name: "no_such_emoji" })).rejects.toMatchObject({
    data: { error: "invalid_name" },
  });
  expect((await client.reactions.add({ ...args, name: "white_check_mark" })).ok).toBe(true);
  expect((await client.reactions.add({ ...args, name: "custom_status" })).ok).toBe(true);
});

test("a post can land while its response is lost, without an implicit fake retry", async () => {
  const { fake, client } = setup(undefined, 40);
  const channel = fake.addChannel();
  fake.failNext("chat.postMessage", { lostResponse: true });
  await expect(
    client.chat.postMessage({
      channel,
      text: "Accepted",
      metadata: { event_type: "toy_box_outbox", event_payload: { id: "lost" } },
    }),
  ).rejects.toMatchObject({ code: ErrorCode.RequestError });
  expect(fake.calls.filter(({ method }) => method === "chat.postMessage")).toHaveLength(1);
  expect(fake.getMessages(channel)).toHaveLength(1);
  expect(
    (await client.conversations.history({ channel, include_all_metadata: true })).messages?.[0]
      .metadata,
  ).toEqual({
    event_type: "toy_box_outbox",
    event_payload: { id: "lost" },
  });
});

test("turning SDK retries on can duplicate a post after its first response is lost", async () => {
  const { fake, client } = setup(undefined, 40, 1);
  const channel = fake.addChannel();
  fake.failNext("chat.postMessage", { lostResponse: true });
  expect((await client.chat.postMessage({ channel, text: "One intended post" })).ok).toBe(true);
  expect(fake.getMessages(channel)).toHaveLength(2);
  expect(fake.calls).toHaveLength(2);
});

test("partial success, a metadata warning, 5xx and rate limits have distinct wire outcomes", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  fake.failNext("chat.postMessage", { error: "internal_error", afterWrite: true });
  await expect(client.chat.postMessage({ channel, text: "Maybe sent" })).rejects.toMatchObject({
    code: ErrorCode.PlatformError,
    data: { error: "internal_error" },
  });
  expect(fake.getMessages(channel)).toHaveLength(1);
  fake.failNext("chat.postMessage", { dropMetadata: true });
  const warning = await client.chat.postMessage({
    channel,
    text: "Sent without metadata",
    metadata: { event_type: "toy_box_outbox", event_payload: { id: "missing" } },
  });
  expect(warning).toMatchObject({ ok: true, warning: "invalid_metadata_schema" });
  expect(fake.getMessages(channel)[1].metadata).toBeUndefined();
  fake.failNext("chat.postMessage", { status: 503 });
  await expect(client.chat.postMessage({ channel, text: "Not sent" })).rejects.toMatchObject({
    code: ErrorCode.HTTPError,
    statusCode: 503,
  });
  fake.failNext("chat.postMessage", { retryAfter: 2 });
  expect((await client.conversations.history({ channel })).ok).toBe(true);
  await expect(client.chat.postMessage({ channel, text: "Limited" })).rejects.toMatchObject({
    code: ErrorCode.RateLimitedError,
    retryAfter: 2,
  });
  expect(fake.getMessages(channel)).toHaveLength(2);
});

test("a misplaced reply can also lose its response, leaving only a root to reconcile", async () => {
  const { fake, client } = setup(undefined, 40);
  const channel = fake.addChannel();
  fake.setMessage(channel, { ts: "1.000001", user: "U1", text: "Question" });
  const metadata = { event_type: "toy_box_outbox", event_payload: { id: "stray" } };
  fake.failNext("chat.postMessage", { misplacedReply: true, lostResponse: true });
  await expect(
    client.chat.postMessage({ channel, thread_ts: "1.000001", text: "Answer", metadata }),
  ).rejects.toMatchObject({ code: ErrorCode.RequestError });
  expect(fake.calls.filter(({ method }) => method === "chat.postMessage")).toHaveLength(1);
  const history = await client.conversations.history({ channel, include_all_metadata: true });
  expect(history.messages).toMatchObject([
    { text: "Answer", bot_id: fake.identity.botId, metadata },
    { ts: "1.000001", text: "Question" },
  ]);
  expect(history.messages?.[0]).not.toHaveProperty("thread_ts");
  expect(history.messages?.[1]).not.toHaveProperty("reply_count");
  expect(
    (await client.conversations.replies({ channel, ts: "1.000001" })).messages?.map(({ ts }) => ts),
  ).toEqual(["1.000001"]);
});

test("only a requested chat.postMessage reply can be misplaced", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  expect(() => fake.failNext("chat.update", { misplacedReply: true })).toThrow(
    "Misplacing a reply is only supported for chat.postMessage.",
  );
  fake.failNext("chat.postMessage", { misplacedReply: true });
  await expect(client.chat.postMessage({ channel, text: "A root" })).rejects.toMatchObject({
    data: { error: "invalid_arguments" },
  });
  expect(fake.getMessages(channel)).toEqual([]);
  await expect(fake.stop()).rejects.toThrow(
    "misplacedReply needs a chat.postMessage with thread_ts.",
  );
});

test("channel/thread refusals remain Slack platform errors, and status expires or clears", async () => {
  let now = 1000;
  const { fake, client } = setup({ now: () => now });
  const channel = fake.addChannel();
  fake.setMessage(channel, { ts: "1.000001" });
  const args = { channel_id: channel, thread_ts: "1.000001" };
  await client.assistant.threads.setStatus({
    ...args,
    status: "Thinking",
    loading_messages: ["Reading"],
  });
  expect(fake.getThreadStatus(channel, "1.000001")).toBe("Thinking");
  now += 120_000;
  expect(fake.getThreadStatus(channel, "1.000001")).toBeNull();
  await client.assistant.threads.setStatus({ ...args, status: "Working" });
  await client.assistant.threads.setStatus({ ...args, status: "" });
  expect(fake.getThreadStatus(channel, "1.000001")).toBeNull();
  await client.assistant.threads.setStatus({ ...args, status: "Replying" });
  await client.chat.postMessage({ channel, thread_ts: "1.000001", text: "Done" });
  expect(fake.getThreadStatus(channel, "1.000001")).toBeNull();
  await expect(
    client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: "9.000001",
      status: "No root",
    }),
  ).rejects.toMatchObject({ data: { error: "invalid_thread_ts" } });
  await expect(
    client.chat.postMessage({ channel, thread_ts: "9.000001", text: "No root" }),
  ).rejects.toMatchObject({ data: { error: "thread_not_found" } });
  fake.setChannel({ id: channel, is_member: false });
  await expect(client.chat.postMessage({ channel, text: "No membership" })).rejects.toMatchObject({
    data: { error: "not_in_channel" },
  });
  fake.setChannel({ id: channel, is_member: true, is_archived: true });
  await expect(client.chat.postMessage({ channel, text: "Archived" })).rejects.toMatchObject({
    data: { error: "is_archived" },
  });
});

test("bad structured arguments fail loudly rather than accepting a JSON-shaped string", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  await expect(
    client.apiCall("chat.postMessage", { channel, text: "Bad", blocks: "not JSON" }),
  ).rejects.toMatchObject({ data: { error: "invalid_arguments" } });
  await expect(fake.stop()).rejects.toThrow("Invalid JSON argument");
});

test("offline seed changes recompute thread counters without retaining a deleted reply or status", async () => {
  const { fake, client } = setup();
  const channel = fake.addChannel();
  const root = await client.chat.postMessage({ channel, text: "Root" });
  const reply = await client.chat.postMessage({ channel, thread_ts: root.ts!, text: "Reply" });
  fake.setMessage(channel, {
    ts: "9000000000.000001",
    thread_ts: root.ts!,
    user: "U1",
    text: "Offline reply",
  });
  expect((await client.conversations.history({ channel })).messages?.[0].reply_count).toBe(2);
  fake.deleteMessage(channel, "9000000000.000001");
  expect((await client.conversations.history({ channel })).messages?.[0].latest_reply).toBe(
    reply.ts,
  );
  fake.deleteMessage(channel, reply.ts!);
  const history = await client.conversations.history({ channel });
  expect(history.messages?.[0].thread_ts).toBeUndefined();
  expect(history.messages?.[0].reply_count).toBeUndefined();
  await client.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: root.ts!,
    status: "Thinking",
  });
  fake.deleteMessage(channel, root.ts!);
  expect(fake.getThreadStatus(channel, root.ts!)).toBeNull();
  await expect(
    client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: root.ts!,
      status: "Deleted",
    }),
  ).rejects.toMatchObject({ data: { error: "invalid_thread_ts" } });
});

// Web API argument/response shapes: https://docs.slack.dev/reference/methods/
// Cursor traversal, including short/empty pages: https://docs.slack.dev/apis/web-api/pagination/
// History is newest first; thread replies are oldest first, with exclusive time bounds by default:
// https://docs.slack.dev/reference/methods/conversations.history/
// https://docs.slack.dev/reference/methods/conversations.replies/
// Identity, scopes header and Enterprise profiles:
// https://docs.slack.dev/reference/methods/auth.test/
// https://docs.slack.dev/reference/methods/bots.info/
// https://docs.slack.dev/reference/objects/user-object/
// Platform errors use HTTP 200; rate limits use HTTP 429 and Retry-After:
// https://docs.slack.dev/apis/web-api/#basics
// https://docs.slack.dev/apis/web-api/rate-limits/
// Writes, ownership and metadata:
// https://docs.slack.dev/reference/methods/chat.postMessage/
// https://docs.slack.dev/reference/methods/chat.delete/
// https://docs.slack.dev/messaging/message-metadata/#receiving_metadata
// https://docs.slack.dev/reference/methods/reactions.add/
// Edit versions and nested message identity:
// https://docs.slack.dev/reference/events/message/message_changed/

import { z } from "zod";
import type { FakeSlackCall, FakeSlackFailure, FakeSlackIdentity } from "./index";

export type FakeSlackChannel = { id: string; [key: string]: unknown };
export type FakeSlackUser = {
  id: string;
  enterprise_user?: { id: string; enterprise_id: string; [key: string]: unknown };
  [key: string]: unknown;
};
export type FakeSlackMessage = {
  ts: string;
  thread_ts?: string;
  [key: string]: unknown;
};
type PageMethod = "conversations.history" | "conversations.replies";

const BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
  "chat:write",
  "metadata.message:read",
  "reactions:write",
];
const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");
const ts = z.string().regex(/^\d+(?:\.\d+)?$/);
const page = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
};
const range = {
  channel: z.string().min(1),
  ...page,
  oldest: ts.optional(),
  latest: ts.optional(),
  inclusive: bool.optional(),
  include_all_metadata: bool.optional(),
};
const json = z.string().transform((text, context): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    context.addIssue({ code: "custom", message: "Invalid JSON argument." });
    return z.NEVER;
  }
});
const object = z.record(z.string(), z.unknown());
const blocks = z.union([json, z.array(object)]).pipe(z.array(object));
const metadata = z.union([json, object]).pipe(object);
const schemas = {
  "apps.connections.open": z.object({}).strict(),
  "auth.test": z.object({}).strict(),
  "bots.info": z.object({ bot: z.string().min(1) }).strict(),
  "conversations.info": z.object({ channel: z.string().min(1) }).strict(),
  "conversations.history": z.object(range).strict(),
  "conversations.replies": z.object({ ...range, ts }).strict(),
  "users.info": z.object({ user: z.string().min(1) }).strict(),
  "chat.postMessage": z
    .object({
      channel: z.string().min(1),
      text: z.string().optional(),
      blocks: blocks.optional(),
      metadata: metadata.optional(),
      parse: z.literal("none").optional(),
      thread_ts: ts.optional(),
      reply_broadcast: bool.pipe(z.literal(false)).optional(),
      unfurl_links: bool.optional(),
      unfurl_media: bool.optional(),
      mrkdwn: bool.optional(),
    })
    .strict(),
  "chat.delete": z.object({ channel: z.string().min(1), ts }).strict(),
  "reactions.add": z
    .object({ channel: z.string().min(1), timestamp: ts, name: z.string().min(1) })
    .strict(),
};

export function createFakeSlackApi(options: {
  identity: FakeSlackIdentity;
  botToken: string;
  appToken: string;
  now: () => number;
  connectionUrl: () => string;
  pageSize?: number;
  emitEvent: (event: Record<string, unknown>, context: Record<string, unknown>) => void;
}) {
  const { identity, now } = options;
  const calls: FakeSlackCall[] = [];
  const problems: string[] = [];
  const channels = new Map<string, FakeSlackChannel>();
  const users = new Map<string, FakeSlackUser>();
  const messages = new Map<string, Map<string, FakeSlackMessage>>();
  const failures = new Map<string, FakeSlackFailure[]>();
  const emptyPages = new Map<PageMethod, number>();
  const cursors = new Map<string, { method: string; query: string; offset: number }>();
  const authChanges: Record<string, unknown> = {};
  const botChanges: Record<string, unknown> = {};
  const pending = new Set<() => void>();
  let timestampMicros = 0n;
  const maxPageSize = options.pageSize ?? 100;
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1)
    throw new Error("Fake Slack pageSize must be a positive integer.");
  const controls = {
    addChannel(settings: Partial<FakeSlackChannel> = {}) {
      const id = settings.id ?? `C${crypto.randomUUID().replaceAll("-", "")}`;
      channels.set(
        id,
        structuredClone({
          id,
          name: "fake-channel",
          is_channel: true,
          is_group: false,
          is_im: false,
          is_mpim: false,
          is_private: false,
          is_member: true,
          is_archived: false,
          is_shared: false,
          is_ext_shared: false,
          is_pending_ext_shared: false,
          is_org_shared: false,
          context_team_id: identity.teamId,
          enterprise_id: identity.enterpriseId,
          shared_team_ids: [],
          ...settings,
        }),
      );
      if (!messages.has(id)) messages.set(id, new Map());
      return id;
    },
    setUser(user: FakeSlackUser, aliases: readonly string[] = []) {
      for (const [id, existing] of users) {
        if (existing.id === user.id) users.set(id, structuredClone(user));
      }
      for (const id of [user.id, user.enterprise_user?.id, ...aliases]) {
        if (id) users.set(id, structuredClone(user));
      }
    },
    setMessage(channelId: string, message: FakeSlackMessage) {
      requireChannel(channelId);
      ts.parse(message.ts);
      if (message.thread_ts !== undefined) ts.parse(message.thread_ts);
      const store = messages.get(channelId)!;
      store.set(message.ts, structuredClone({ type: "message", ...message }));
    },
    deleteMessage(channelId: string, timestamp: string) {
      requireChannel(channelId);
      const store = messages.get(channelId)!;
      store.delete(timestamp);
    },
    getMessages(channelId: string) {
      requireChannel(channelId);
      return [...messages.get(channelId)!.values()]
        .sort((a, b) => compareTs(a.ts, b.ts))
        .map((message) => messageSnapshot(channelId, message));
    },
    setAuthResponse(changes: Record<string, unknown>) {
      Object.assign(authChanges, structuredClone(changes));
    },
    setBotResponse(changes: Record<string, unknown>) {
      Object.assign(botChanges, structuredClone(changes));
    },
    emptyNextPage(method: PageMethod) {
      emptyPages.set(method, (emptyPages.get(method) ?? 0) + 1);
    },
  };
  controls.setUser({
    id: identity.botUserId,
    team_id: identity.teamId,
    name: "toy-box",
    is_bot: true,
    deleted: false,
  });

  function requireChannel(id: string): FakeSlackChannel {
    const channel = channels.get(id);
    if (!channel) throw new Error(`Unknown seeded Slack channel ${id}.`);
    return channel;
  }

  function unexpected(message: string): Response {
    problems.push(message);
    return Response.json({
      ok: false,
      error: "invalid_arguments",
      response_metadata: { messages: [message] },
    });
  }

  function failure(error: string, messages?: string[]): Response {
    return Response.json({
      ok: false,
      error,
      ...(messages && { response_metadata: { messages } }),
    });
  }

  function timestamp(): string {
    const wall = BigInt(Math.floor(now() * 1000));
    timestampMicros = wall > timestampMicros ? wall : timestampMicros + 1n;
    return `${timestampMicros / 1_000_000n}.${String(timestampMicros % 1_000_000n).padStart(6, "0")}`;
  }

  function writeProblem(channelId: string): string | null {
    const channel = channels.get(channelId);
    if (!channel) return "channel_not_found";
    if (channel.is_member === false) return "not_in_channel";
    if (channel.is_archived) return "is_archived";
    return null;
  }

  function childrenOf(channelId: string, rootTs: string): FakeSlackMessage[] {
    return [...messages.get(channelId)!.values()].filter(
      (message) => message.thread_ts === rootTs && message.ts !== rootTs,
    );
  }

  function threadFacts(root: FakeSlackMessage, replies: FakeSlackMessage[]): void {
    for (const field of ["thread_ts", "reply_count", "latest_reply"]) delete root[field];
    if (!replies.length) return;
    Object.assign(root, {
      thread_ts: root.ts,
      reply_count: replies.length,
      latest_reply: replies.reduce(
        (latest, message) => (compareTs(message.ts, latest) > 0 ? message.ts : latest),
        replies[0].ts,
      ),
    });
  }

  function messageSnapshot(
    channelId: string,
    message: FakeSlackMessage,
    fullMetadata = true,
  ): FakeSlackMessage {
    const result = structuredClone(message);
    if (!message.thread_ts || message.thread_ts === message.ts)
      threadFacts(result, childrenOf(channelId, message.ts));
    if (!fullMetadata && object.safeParse(result.metadata).success) {
      const current = object.parse(result.metadata);
      if ("event_type" in current) result.metadata = { event_type: current.event_type };
    }
    return result;
  }

  function emitMessage(channelId: string, event: Record<string, unknown>): void {
    const channel = requireChannel(channelId);
    options.emitEvent(
      {
        ...event,
        channel: channelId,
        channel_type: channel.is_private ? "group" : "channel",
      },
      { is_ext_shared_channel: channel.is_ext_shared === true },
    );
  }

  function emitChanged(
    channelId: string,
    message: FakeSlackMessage,
    previous: FakeSlackMessage,
  ): void {
    const at = timestamp();
    emitMessage(channelId, {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      message: structuredClone(message),
      previous_message: structuredClone(previous),
      ts: at,
      event_ts: at,
    });
  }

  function post(
    requested: z.output<(typeof schemas)["chat.postMessage"]>,
    injected?: FakeSlackFailure,
  ): Response {
    const misplaced = injected !== undefined && "misplacedReply" in injected;
    if (misplaced && requested.thread_ts === undefined)
      return unexpected("misplacedReply needs a chat.postMessage with thread_ts.");
    // Slack accepted the reply as a new root, so the store, the event and the receipt all say so.
    const input = misplaced ? { ...requested, thread_ts: undefined } : requested;
    const problem = writeProblem(input.channel);
    if (problem) return failure(problem);
    if (!input.text && !input.blocks?.length) return failure("no_text");
    const store = messages.get(input.channel)!;
    const parent = input.thread_ts === undefined ? undefined : store.get(input.thread_ts);
    if (input.thread_ts && (!parent || (parent.thread_ts && parent.thread_ts !== parent.ts)))
      return failure("thread_not_found");
    let messageTs = timestamp();
    while (store.has(messageTs)) messageTs = timestamp();
    const message: FakeSlackMessage = {
      type: "message",
      team: identity.teamId,
      user: identity.botUserId,
      bot_id: identity.botId,
      app_id: identity.appId,
      text: input.text ?? "",
      ts: messageTs,
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      ...(parent && typeof parent.user === "string" ? { parent_user_id: parent.user } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
    };
    const dropMetadata =
      input.metadata !== undefined &&
      (typeof input.metadata.event_type !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(input.metadata.event_type) ||
        !object.safeParse(input.metadata.event_payload).success);
    if (input.metadata && !dropMetadata) message.metadata = structuredClone(input.metadata);
    store.set(message.ts, message);
    emitMessage(input.channel, { ...structuredClone(message), event_ts: message.ts });
    return Response.json({
      ok: true,
      channel: input.channel,
      ts: message.ts,
      message,
      ...(dropMetadata
        ? {
            warning: "invalid_metadata_schema",
            response_metadata: { warnings: ["invalid_metadata_schema"] },
          }
        : {}),
    });
  }

  function remove(input: z.output<(typeof schemas)["chat.delete"]>): Response {
    const problem = writeProblem(input.channel);
    if (problem) return failure(problem);
    const store = messages.get(input.channel)!;
    const message = store.get(input.ts);
    if (!message) return failure("message_not_found");
    if (message.user !== identity.botUserId) return failure("cant_delete_message");
    const root =
      message.thread_ts && message.thread_ts !== message.ts
        ? store.get(message.thread_ts)
        : undefined;
    const previousRoot = root ? messageSnapshot(input.channel, root) : undefined;
    store.delete(input.ts);
    const at = timestamp();
    emitMessage(input.channel, {
      type: "message",
      subtype: "message_deleted",
      hidden: true,
      deleted_ts: input.ts,
      previous_message: structuredClone(message),
      ts: at,
      event_ts: at,
    });
    if (root && previousRoot) {
      emitChanged(input.channel, messageSnapshot(input.channel, root), previousRoot);
    }
    return Response.json({ ok: true, channel: input.channel, ts: input.ts });
  }

  function reaction(input: z.output<(typeof schemas)["reactions.add"]>): Response {
    const problem = writeProblem(input.channel);
    if (problem) return failure(problem);
    const message = messages.get(input.channel)!.get(input.timestamp);
    if (!message) return failure("message_not_found");
    if (!["eyes", "white_check_mark", "thumbsup"].includes(input.name))
      return failure("invalid_name");
    const list = z
      .array(z.object({ name: z.string(), count: z.number(), users: z.array(z.string()) }))
      .parse(message.reactions ?? []);
    const current = list.find((entry) => entry.name === input.name);
    const has = current?.users.includes(identity.botUserId);
    if (has) return failure("already_reacted");
    if (current) {
      current.users.push(identity.botUserId);
      current.count += 1;
    } else list.push({ name: input.name, count: 1, users: [identity.botUserId] });
    message.reactions = list;
    return Response.json({ ok: true });
  }

  function paged(
    method: PageMethod,
    args: z.output<(typeof schemas)["conversations.history"]>,
    items: FakeSlackMessage[],
  ): Response {
    const query = JSON.stringify({ ...args, cursor: undefined, limit: undefined });
    const cursor =
      typeof args.cursor === "string" && args.cursor ? cursors.get(args.cursor) : undefined;
    if (args.cursor && (!cursor || cursor.method !== method || cursor.query !== query))
      return failure("invalid_cursor");
    const offset = cursor?.offset ?? 0;
    const limit = Math.min(typeof args.limit === "number" ? args.limit : 100, maxPageSize);
    const empty = (emptyPages.get(method) ?? 0) > 0;
    if (empty) emptyPages.set(method, emptyPages.get(method)! - 1);
    const result = empty ? [] : items.slice(offset, offset + limit);
    const nextOffset = offset + result.length;
    let nextCursor = "";
    if (nextOffset < items.length) {
      nextCursor = Buffer.from(crypto.randomUUID()).toString("base64");
      cursors.set(nextCursor, { method, query, offset: nextOffset });
    }
    return Response.json({
      ok: true,
      messages: result,
      has_more: nextCursor !== "",
      response_metadata: { next_cursor: nextCursor },
      ...(method === "conversations.history"
        ? {
            pin_count: 0,
            channel_actions_ts: null,
            channel_actions_count: 0,
          }
        : {}),
    });
  }

  function history(
    method: "conversations.history" | "conversations.replies",
    args: z.output<(typeof schemas)["conversations.history"]> & { ts?: string },
  ): Response {
    const channel = channels.get(args.channel);
    if (!channel) return failure("channel_not_found");
    if (channel.is_member === false) return failure("not_in_channel");
    let list = [...messages.get(args.channel)!.values()];
    if (method === "conversations.replies") {
      const target = list.find((message) => message.ts === args.ts);
      if (!target || target.subtype === "channel_join" || target.subtype === "channel_leave")
        return failure("thread_not_found");
      const root = target.thread_ts ?? target.ts;
      if (!list.some((message) => message.ts === root)) return failure("thread_not_found");
      list = list.filter((message) => message.ts === root || message.thread_ts === root);
    } else {
      list = list.filter(
        (message) =>
          !message.thread_ts ||
          message.thread_ts === message.ts ||
          message.subtype === "thread_broadcast",
      );
    }
    const inclusive = args.inclusive ?? false;
    list = list.filter(
      (message) =>
        (args.oldest === undefined || compareTs(message.ts, args.oldest) >= (inclusive ? 0 : 1)) &&
        (args.latest === undefined || compareTs(message.ts, args.latest) <= (inclusive ? 0 : -1)),
    );
    list.sort((a, b) => compareTs(a.ts, b.ts) * (method === "conversations.history" ? -1 : 1));
    const projected = list.map((message) =>
      messageSnapshot(args.channel, message, args.include_all_metadata ?? false),
    );
    return paged(method, args, projected);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.slice("/api/".length);
    const contentType = request.headers.get("content-type") ?? "";
    if (request.method !== "POST" || !contentType.startsWith("application/x-www-form-urlencoded"))
      return unexpected(`${method} used unexpected HTTP method/content type.`);
    const args = Object.fromEntries(new URLSearchParams(await request.text()));
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    calls.push({ method, args: structuredClone(args), token, at: now() });
    function run<T extends z.ZodType>(
      schema: T,
      work: (input: z.output<T>, injected?: FakeSlackFailure) => Response,
    ): Response | Promise<Response> {
      const input = schema.safeParse(args);
      if (!input.success) return unexpected(`${method}: ${input.error.message}`);
      if (token !== (method === "apps.connections.open" ? options.appToken : options.botToken))
        return failure(token ? "invalid_auth" : "not_authed");
      const injected = failures.get(method)?.shift();
      if (injected) {
        if ("retryAfter" in injected)
          return Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "Retry-After": String(injected.retryAfter) } },
          );
        if ("status" in injected)
          return Response.json(
            { ok: false, error: "service_unavailable" },
            { status: injected.status },
          );
        if ("error" in injected) return failure(injected.error, injected.messages);
      }
      const response = work(input.data, injected);
      if (injected && "lostResponse" in injected) {
        // Keep the accepted operation, but give the caller no response until its own timeout.
        return new Promise<Response>((resolve) => {
          const finish = () => {
            pending.delete(finish);
            request.signal.removeEventListener("abort", finish);
            resolve(Response.error());
          };
          pending.add(finish);
          if (request.signal.aborted) finish();
          else request.signal.addEventListener("abort", finish, { once: true });
        });
      }
      return response;
    }
    switch (method) {
      case "apps.connections.open":
        return run(schemas[method], () =>
          Response.json({ ok: true, url: options.connectionUrl() }),
        );
      case "auth.test":
        return run(schemas[method], () =>
          Response.json(
            {
              ok: true,
              url: "https://fake-workspace.slack.com/",
              team: "Fake workspace",
              user: "toy-box",
              team_id: identity.teamId,
              user_id: identity.botUserId,
              bot_id: identity.botId,
              is_enterprise_install: false,
              ...(identity.enterpriseId ? { enterprise_id: identity.enterpriseId } : {}),
              ...authChanges,
            },
            { headers: { "x-oauth-scopes": BOT_SCOPES.join(",") } },
          ),
        );
      case "bots.info":
        return run(schemas[method], (input) =>
          input.bot !== identity.botId
            ? failure("bot_not_found")
            : Response.json({
                ok: true,
                bot: {
                  id: identity.botId,
                  user_id: identity.botUserId,
                  app_id: identity.appId,
                  name: "toy-box",
                  deleted: false,
                  ...botChanges,
                },
              }),
        );
      case "conversations.info":
        return run(schemas[method], (input) => {
          const channel = channels.get(input.channel);
          if (!channel) return failure("channel_not_found");
          return Response.json({ ok: true, channel });
        });
      case "conversations.history":
      case "conversations.replies":
        return run(schemas[method], (input) => history(method, input));
      case "users.info":
        return run(schemas[method], (input) => {
          const user = users.get(input.user);
          return user ? Response.json({ ok: true, user }) : failure("user_not_found");
        });
      case "chat.postMessage":
        return run(schemas[method], post);
      case "chat.delete":
        return run(schemas[method], remove);
      case "reactions.add":
        return run(schemas[method], reaction);
      default:
        return unexpected(`Unknown fake Slack method: ${method}`);
    }
  }

  return {
    controls,
    calls,
    problems,
    handle,
    finishPending() {
      for (const finish of pending) finish();
    },
    failNext: (method: string, injected: FakeSlackFailure) => {
      if (!Object.hasOwn(schemas, method))
        throw new Error(`Cannot inject an unknown Slack method ${method}.`);
      if (
        "retryAfter" in injected &&
        (!Number.isFinite(injected.retryAfter) || injected.retryAfter < 0)
      )
        throw new Error("Retry-After must be nonnegative and finite.");
      if (
        "status" in injected &&
        (!Number.isInteger(injected.status) || injected.status < 400 || injected.status > 599)
      )
        throw new Error("HTTP failure status must be between 400 and 599.");
      if ("misplacedReply" in injected && method !== "chat.postMessage")
        throw new Error("Misplacing a reply is only supported for chat.postMessage.");
      const queue = failures.get(method) ?? [];
      queue.push(structuredClone(injected));
      failures.set(method, queue);
    },
  };
}

function compareTs(left: string, right: string): number {
  const [a, af = ""] = left.split(".");
  const [b, bf = ""] = right.split(".");
  if (BigInt(a) !== BigInt(b)) return BigInt(a) < BigInt(b) ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  return af.padEnd(width, "0").localeCompare(bf.padEnd(width, "0"));
}

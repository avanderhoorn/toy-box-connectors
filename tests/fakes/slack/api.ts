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
type PageMethod =
  | "conversations.history"
  | "conversations.replies"
  | "conversations.list"
  | "conversations.members"
  | "users.list";

export type FakeSlackReads = {
  addChannel(options?: Partial<FakeSlackChannel> & { members?: string[] }): string;
  /** Replaces the wire object exactly, including deliberately absent fields. */
  setChannel(channel: FakeSlackChannel): void;
  setMembers(channelId: string, members: readonly string[]): void;
  setUser(user: FakeSlackUser, aliases?: readonly string[]): void;
  setMessage(channelId: string, message: FakeSlackMessage): void;
  deleteMessage(channelId: string, ts: string): void;
  getMessages(channelId: string): readonly FakeSlackMessage[];
  setAuthResponse(changes: Record<string, unknown>): void;
  setBotResponse(changes: Record<string, unknown>): void;
  emptyNextPage(method: PageMethod): void;
};

const BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
  "chat:write",
  "metadata.message:read",
  "files:read",
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
const schemas = {
  "apps.connections.open": z.object({}).strict(),
  "auth.test": z.object({}).strict(),
  "bots.info": z.object({ bot: z.string().min(1), team_id: z.string().optional() }).strict(),
  "conversations.info": z
    .object({
      channel: z.string().min(1),
      include_locale: bool.optional(),
      include_num_members: bool.optional(),
    })
    .strict(),
  "conversations.history": z.object(range).strict(),
  "conversations.replies": z.object({ ...range, ts }).strict(),
  "conversations.members": z.object({ channel: z.string().min(1), ...page }).strict(),
  "conversations.list": z
    .object({
      ...page,
      exclude_archived: bool.optional(),
      types: z.string().optional(),
      team_id: z.string().optional(),
    })
    .strict(),
  "users.info": z.object({ user: z.string().min(1), include_locale: bool.optional() }).strict(),
  "users.list": z
    .object({ ...page, include_locale: bool.optional(), team_id: z.string().optional() })
    .strict(),
};

export function createFakeSlackApi(options: {
  identity: FakeSlackIdentity;
  botToken: string;
  appToken: string;
  now: () => number;
  connectionUrl: () => string;
  scopes?: readonly string[];
  pageSize?: number;
}) {
  const { identity, now } = options;
  const calls: FakeSlackCall[] = [];
  const problems: string[] = [];
  const channels = new Map<string, FakeSlackChannel>();
  const members = new Map<string, string[]>();
  const users = new Map<string, FakeSlackUser>();
  const messages = new Map<string, Map<string, FakeSlackMessage>>();
  const failures = new Map<string, FakeSlackFailure[]>();
  const emptyPages = new Map<PageMethod, number>();
  const cursors = new Map<string, { method: string; query: string; offset: number }>();
  const authChanges: Record<string, unknown> = {};
  const botChanges: Record<string, unknown> = {};
  const maxPageSize = options.pageSize ?? 100;
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1)
    throw new Error("Fake Slack pageSize must be a positive integer.");
  const controls: FakeSlackReads = {
    addChannel(settings = {}) {
      const { members: channelMembers, ...facts } = settings;
      const id = settings.id ?? `C${crypto.randomUUID().replaceAll("-", "")}`;
      controls.setChannel({
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
        ...facts,
      });
      controls.setMembers(
        id,
        channelMembers ?? (facts.is_member === false ? [] : [identity.botUserId]),
      );
      return id;
    },
    setChannel(channel) {
      channels.set(channel.id, structuredClone(channel));
      if (!messages.has(channel.id)) messages.set(channel.id, new Map());
      if (!members.has(channel.id))
        members.set(channel.id, channel.is_member === false ? [] : [identity.botUserId]);
    },
    setMembers(channelId, ids) {
      const channel = requireChannel(channelId);
      members.set(channelId, [...new Set(ids)]);
      channel.is_member = ids.includes(identity.botUserId);
    },
    setUser(user, aliases = []) {
      for (const id of [user.id, user.enterprise_user?.id, ...aliases]) {
        if (id) users.set(id, structuredClone(user));
      }
    },
    setMessage(channelId, message) {
      requireChannel(channelId);
      ts.parse(message.ts);
      if (message.thread_ts !== undefined) ts.parse(message.thread_ts);
      messages.get(channelId)!.set(message.ts, structuredClone({ type: "message", ...message }));
    },
    deleteMessage(channelId, timestamp) {
      requireChannel(channelId);
      messages.get(channelId)!.delete(timestamp);
    },
    getMessages(channelId) {
      requireChannel(channelId);
      return [...messages.get(channelId)!.values()]
        .sort((a, b) => compareTs(a.ts, b.ts))
        .map((message) => structuredClone(message));
    },
    setAuthResponse(changes) {
      Object.assign(authChanges, structuredClone(changes));
    },
    setBotResponse(changes) {
      Object.assign(botChanges, structuredClone(changes));
    },
    emptyNextPage(method) {
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

  function failure(error: string): Response {
    return Response.json({ ok: false, error });
  }

  function paged(
    method: PageMethod,
    args: z.output<(typeof schemas)["conversations.history"]> | Record<string, unknown>,
    items: unknown[],
    key: string,
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
      [key]: result,
      has_more: nextCursor !== "",
      response_metadata: { next_cursor: nextCursor },
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
    const projected = list.map((message) => {
      const result = structuredClone(message);
      const replies = [...messages.get(args.channel)!.values()].filter(
        (item) => item.thread_ts === message.ts && item.ts !== message.ts,
      );
      if (replies.length) {
        result.thread_ts = message.ts;
        result.reply_count = replies.length;
        result.latest_reply = replies.reduce(
          (latest, item) => (compareTs(item.ts, latest) > 0 ? item.ts : latest),
          replies[0].ts,
        );
      }
      if (
        !args.include_all_metadata &&
        typeof result.metadata === "object" &&
        result.metadata !== null &&
        "event_type" in result.metadata
      ) {
        result.metadata = { event_type: result.metadata.event_type };
      }
      return result;
    });
    return paged(method, args, projected, "messages");
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.slice("/api/".length);
    let args: unknown;
    const contentType = request.headers.get("content-type") ?? "";
    try {
      if (request.method === "GET") args = Object.fromEntries(url.searchParams);
      else if (
        request.method === "POST" &&
        contentType.startsWith("application/x-www-form-urlencoded")
      )
        args = Object.fromEntries(new URLSearchParams(await request.text()));
      else if (request.method === "POST" && contentType.startsWith("application/json"))
        args = await request.json();
      else return unexpected(`${method} used unexpected HTTP method/content type.`);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return unexpected(`${method} sent invalid JSON.`);
    }
    const record = z.record(z.string(), z.unknown()).safeParse(args);
    if (!record.success) return unexpected(`${method} body is not an object.`);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    calls.push({ method, args: structuredClone(record.data), token, at: now() });
    function run<T extends z.ZodType>(schema: T, work: (input: z.output<T>) => Response): Response {
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
        return failure(injected.error);
      }
      return work(input.data);
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
              team_id: identity.teamId,
              user_id: identity.botUserId,
              bot_id: identity.botId,
              is_enterprise_install: false,
              ...(identity.enterpriseId ? { enterprise_id: identity.enterpriseId } : {}),
              ...authChanges,
            },
            { headers: { "x-oauth-scopes": (options.scopes ?? BOT_SCOPES).join(",") } },
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
          return Response.json({
            ok: true,
            channel: {
              ...channel,
              ...(input.include_num_members
                ? { num_members: members.get(input.channel)!.length }
                : {}),
            },
          });
        });
      case "conversations.history":
      case "conversations.replies":
        return run(schemas[method], (input) => history(method, input));
      case "conversations.members":
        return run(schemas[method], (input) =>
          channels.has(input.channel)
            ? paged(method, input, members.get(input.channel)!, "members")
            : failure("channel_not_found"),
        );
      case "conversations.list":
        return run(schemas[method], (input) => {
          const types = (input.types ?? "public_channel").split(",");
          const list = [...channels.values()].filter(
            (channel) =>
              (!input.exclude_archived || !channel.is_archived) &&
              types.includes(channel.is_private ? "private_channel" : "public_channel") &&
              (!channel.is_private || channel.is_member !== false),
          );
          return paged(method, input, list, "channels");
        });
      case "users.info":
        return run(schemas[method], (input) => {
          const user = users.get(input.user);
          return user ? Response.json({ ok: true, user }) : failure("user_not_found");
        });
      case "users.list":
        return run(schemas[method], (input) =>
          paged(
            method,
            input,
            [...new Map([...users.values()].map((user) => [user.id, user])).values()],
            "members",
          ),
        );
      default:
        return unexpected(`Unknown fake Slack method: ${method}`);
    }
  }

  return {
    controls,
    calls,
    problems,
    handle,
    failNext(method: string, injected: FakeSlackFailure) {
      if (!Object.hasOwn(schemas, method))
        throw new Error(`Cannot inject an unknown Slack method ${method}.`);
      if (
        "retryAfter" in injected &&
        (!Number.isFinite(injected.retryAfter) || injected.retryAfter < 0)
      )
        throw new Error("Retry-After must be nonnegative and finite.");
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

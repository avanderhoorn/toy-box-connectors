import { describe, expect, onTestFinished, spyOn, test } from "bun:test";
import { z } from "zod";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { CallerFacts } from "@commands/model/callers";
import {
  commandContract,
  CommandRefusedError,
  type CommandHandlersFor,
} from "@commands/model/contract";
import { commandPath, type CommandRefusal } from "@commands/model/protocol";
import type { SlackState } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import type { ToyBoxCatalog } from "@toybox/model";
import { serveCommands } from "./serve";

const AT = Date.parse("2026-10-27T16:00:00Z");

const catalog: ToyBoxCatalog = {
  version: 1,
  channels: [{ id: "toybox-link", name: "Release engineering", model: { provider: "copilot" } }],
  members: [{ id: "agent-reviewer", channelId: "toybox-link", name: "Reviewer" }],
  working: [],
};

const lead = { sessionId: "toybox-link", toyBoxPort: 3000, channelId: null };
const member = { sessionId: "agent-reviewer", toyBoxPort: 3000, channelId: null };
const operator = { sessionId: null, toyBoxPort: null, channelId: "toybox-link" };

const done = z.object({ done: z.string() }).strict();
const contracts = {
  pause: commandContract({
    description: "Pause the channel's link",
    roles: ["lead", "operator"],
    scope: "channel",
    input: z.object({ note: z.string().optional().describe("Why it's paused") }).strict(),
    result: done,
    present: (result) => result.done,
  }),
  peek: commandContract({
    description: "Look at the bridge, even without Slack",
    roles: ["lead", "member", "operator"],
    scope: "bridge",
    withoutSlack: true,
    input: z.object({}).strict(),
    result: done,
    present: (result) => result.done,
  }),
  sweep: commandContract({
    description: "Something only the operator may do",
    roles: ["operator"],
    scope: "bridge",
    input: z.object({}).strict(),
    result: done,
    present: (result) => result.done,
  }),
};
type Handlers = CommandHandlersFor<typeof contracts>;

/** Any answer, loosely, so a test can compare it whole or pick at it. */
type Answer = Partial<CommandRefusal> & { result?: unknown; error?: string };

type ServerOptions = {
  catalog?: ToyBoxCatalog | null;
  loadCatalog?: () => Promise<ToyBoxCatalog>;
  slack?: SlackState;
  pause?: (database: BridgeDatabase) => Handlers["pause"];
};

async function startServer(options: ServerOptions = {}) {
  const database = await openTestDatabase();
  await createStoredLink(database);
  let loads = 0;
  const pause = options.pause ?? pauseLink;
  const answer = serveCommands({
    contracts,
    handlers: {
      pause: pause(database),
      peek: async (_input, { caller }) => ({ done: `${caller.role} looked` }),
      sweep: async () => ({ done: "swept" }),
    },
    database,
    origin: new URL("http://127.0.0.1:3000"),
    toyBox: {
      catalog: () => (options.catalog === undefined ? catalog : options.catalog),
      loadCatalog: () => {
        loads += 1;
        return options.loadCatalog?.() ?? Promise.resolve(catalog);
      },
    },
    slack: () => options.slack ?? { connection: "connected", problem: null },
    now: () => AT,
  });

  async function call(name: string, caller: CallerFacts, input: unknown = {}) {
    const response = await answer(
      new Request(`http://bridge${commandPath(name)}`, {
        method: "POST",
        body: JSON.stringify({ caller, input }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Answer };
  }

  return { answer, call, database, loads: () => loads };
}

function pauseLink(database: BridgeDatabase): Handlers["pause"] {
  return async (_input, { caller, at }) => {
    await database.write(
      (transaction) => transaction`
        UPDATE links SET status = 'paused', updated_at = ${at}
        WHERE toybox_channel_id = ${caller.channelId}
      `,
    );
    return { done: `paused ${caller.channelId}` };
  };
}

function quietLog() {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

describe("answering a call", () => {
  test("runs the command for whoever's calling, and reads the banner after it", async () => {
    const { call } = await startServer();

    expect(await call("pause", lead)).toEqual({
      status: 200,
      body: {
        version: 1,
        at: AT,
        banner: {
          slack: "connected",
          coverage: "complete",
          warnings: [{ kind: "link_inactive", status: "paused", reason: null }],
          restore: null,
        },
        result: { done: "paused toybox-link" },
      },
    });
    expect((await call("peek", member)).body.result).toEqual({ done: "member looked" });
    expect((await call("pause", operator)).body.result).toEqual({ done: "paused toybox-link" });
  });

  test("looks a session up once more before believing it's a stranger", async () => {
    const { call, loads } = await startServer({ catalog: null });

    expect((await call("peek", member)).body.result).toEqual({ done: "member looked" });
    expect(loads()).toBe(1);
    expect(await call("peek", { ...member, sessionId: "agent-stranger" })).toEqual({
      status: 403,
      body: {
        version: 1,
        at: AT,
        banner: null,
        refused: {
          rule: "unknown_session",
          message:
            "Session agent-stranger isn't the lead or a member of a channel in the Toy Box at http://127.0.0.1:3000, so the bridge won't act for it.",
        },
      },
    });
    expect(loads()).toBe(2);
  });

  test("tells a refused caller nothing about any channel", async () => {
    const { call, loads } = await startServer();

    const refused = async (name: string, caller: CallerFacts) => {
      const { status, body } = await call(name, caller);
      expect(body.banner).toBeNull();
      return { status, rule: body.refused?.rule };
    };
    expect(await refused("peek", { ...lead, toyBoxPort: 3100 })).toEqual({
      status: 403,
      rule: "toy_box_port",
    });
    expect(await refused("pause", { ...lead, channelId: "toybox-other" })).toEqual({
      status: 403,
      rule: "channel_mismatch",
    });
    expect(await refused("pause", member)).toEqual({ status: 403, rule: "role" });
    expect(await refused("sweep", lead)).toEqual({ status: 403, rule: "role" });
    expect(await refused("pause", { ...operator, channelId: null })).toEqual({
      status: 403,
      rule: "channel_required",
    });
    expect(loads()).toBe(0);
  });

  test("says so when it can't reach Toy Box to tell who's calling", async () => {
    const log = quietLog();
    const { call } = await startServer({
      catalog: null,
      loadCatalog: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });

    expect(await call("peek", member)).toEqual({
      status: 503,
      body: {
        version: 1,
        at: AT,
        banner: null,
        refused: {
          rule: "toy_box_unreachable",
          message:
            "The bridge couldn't reach the Toy Box at http://127.0.0.1:3000 to tell who you are. Check that Toy Box is running, then try again.",
        },
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect((await call("peek", operator)).status).toBe(200);
  });

  test.each([
    ["unconfigured", "SLACK_APP_TOKEN isn't set."],
    ["auth_failed", "Slack rejected the bot token."],
    ["refused", "The tokens belong to another Slack app."],
  ] as const)(
    "runs only what doesn't need Slack while Slack is %s",
    async (connection, problem) => {
      const { call } = await startServer({ slack: { connection, problem } });

      const { status, body } = await call("pause", lead);
      expect(status).toBe(503);
      expect(body.banner?.slack).toBe(connection);
      expect(body.refused).toEqual({
        rule: "slack_unavailable",
        message: `\`pause\` needs Slack, which the bridge can't use right now. ${problem} Until then it runs only \`status\` and \`doctor\`.`,
      });
      expect((await call("peek", lead)).status).toBe(200);
    },
  );

  test.each(["connecting", "reconnecting"] as const)(
    "runs every command while Slack is %s, so posts wait for it",
    async (connection) => {
      const { call } = await startServer({ slack: { connection, problem: null } });

      expect((await call("pause", lead)).status).toBe(200);
    },
  );

  test("refuses input its contract doesn't take, naming the option", async () => {
    const { call, database } = await startServer();

    const { status, body } = await call("pause", lead, { note: 5 });
    expect(status).toBe(422);
    expect(body.banner?.warnings).toEqual([]);
    expect(body.refused?.rule).toBe("invalid_input");
    expect(body.refused?.message).toStartWith("--note: ");
    expect(body.refused?.message).toEndWith("Run `toy-box-slack pause --help`.");
    const [link] = await database.read((sql) => sql`SELECT status FROM links`);
    expect(link).toEqual({ status: "active" });
  });

  test("answers a handler's refusal with the banner", async () => {
    const { call } = await startServer({
      pause: () => async () => {
        throw new CommandRefusedError("already_paused", "The link is already paused.");
      },
    });

    const { status, body } = await call("pause", lead);
    expect(status).toBe(409);
    expect(body.banner?.slack).toBe("connected");
    expect(body.refused).toEqual({
      rule: "already_paused",
      message: "The link is already paused.",
    });
  });

  test("logs anything else that goes wrong, and tells the caller where to look", async () => {
    const log = quietLog();
    const failing = async (pause: ServerOptions["pause"]) =>
      (await startServer({ pause })).call("pause", lead);
    const answer = {
      status: 500,
      body: { error: "The bridge couldn't finish `pause`. Its log says why." },
    };

    expect(await failing(() => () => Promise.reject(new Error("disk I/O error")))).toEqual(answer);
    expect(await failing(() => async () => ({ done: 7 }) as never)).toEqual(answer);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("requests that aren't calls", () => {
  test("are answered with what's wrong", async () => {
    const { answer } = await startServer();
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await answer(new Request(`http://bridge${path}`, init));
      const body = (await response.json()) as Answer;
      return { status: response.status, allow: response.headers.get("Allow"), ...body };
    };
    const post = (body: string) => ({ method: "POST", body });

    expect(await request("/v1/commands/unlink", post("{}"))).toEqual({
      status: 404,
      allow: null,
      error: "The bridge has no command at /v1/commands/unlink.",
    });
    expect((await request("/v1/commands/constructor", post("{}"))).status).toBe(404);
    expect((await request("/", post("{}"))).status).toBe(404);
    expect(await request("/v1/commands/peek")).toEqual({
      status: 405,
      allow: "POST",
      error: "Commands take POST, not GET.",
    });
    const unreadable = {
      status: 400,
      allow: null,
      error: "The bridge couldn't read the call to `peek`.",
    };
    expect(await request("/v1/commands/peek", post("not json"))).toEqual(unreadable);
    expect(await request("/v1/commands/peek", post(JSON.stringify({ input: {} })))).toEqual(
      unreadable,
    );
    expect(
      await request("/v1/commands/peek", post(JSON.stringify({ caller: operator, input: [] }))),
    ).toEqual(unreadable);
  });
});

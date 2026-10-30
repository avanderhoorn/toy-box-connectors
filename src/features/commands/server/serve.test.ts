import { expect, mock, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import { captureLog, openTestDatabase } from "@bridge/server/testFixtures";
import { COMMANDS_PATH, CommandRefusedError } from "@commands/model/protocol";
import { createStoredLink } from "@links/server/testFixtures";
import { labeledLog, log } from "@/shared/log";
import {
  serveCommands,
  type AppCommandHandlers,
  type CommandContext,
  type ServedApp,
} from "./serve";
import type { StatusCommand } from "./status";

const LEAD = { sessionId: "toybox-link", channelId: null };
const TERMINAL = { sessionId: null, channelId: null };
const DISMISS = { request: "r1", reason: "Done" };

/** What the bridge answered, as far as these tests read it. */
type Answer = {
  result?: { app?: string; apps?: string[]; channelId?: string | null; at?: number };
  text?: string;
  error?: string;
};

type App = {
  name: string;
  /** The links its bridge.db holds, by the names createStoredLink takes. */
  links: string[];
  handlers?: Partial<AppCommandHandlers>;
};

/** Each app's commands answer where they ran and for whom, except inbox refuses and dismiss fails. */
function handlersIn(app: string): AppCommandHandlers {
  const ran = async (_input: unknown, context: CommandContext) => ({
    result: { app, ...context },
    text: `Ran in the ${app} app.`,
  });
  return {
    inbox: async () => {
      throw new CommandRefusedError("Run it later.");
    },
    dismiss: async () => {
      throw new Error("The disk is full.");
    },
    reply: ran,
    activity: ran,
    "mark-read": ran,
    publish: ran,
    retract: ran,
    link: ran,
    allow: ran,
    deny: ran,
    pause: ran,
    resume: ran,
    unlink: ran,
  };
}

/** Status answers which apps it showed, and for whom. */
const status: StatusCommand = async (apps, context) => ({
  result: { apps: apps.map((app) => app.name), ...context },
  text: "Linked.",
});

/**
 * A bridge hosting `apps`, the default app with the link toybox-link unless they say otherwise,
 * which answers each call with its status and what it said.
 */
async function serving(apps: App[] = [{ name: DEFAULT_APP, links: ["link"] }]) {
  const served: (ServedApp & { onChange: ReturnType<typeof mock> })[] = [];
  for (const { name, links, handlers } of apps) {
    const database = await openTestDatabase();
    for (const link of links) await createStoredLink(database, link);
    served.push({
      name,
      database,
      slack: () => ({ connection: "connected", problem: null }),
      workspaceUrl: () => null,
      handlers: { ...handlersIn(name), ...handlers },
      log: name === DEFAULT_APP ? log : labeledLog(name),
      onChange: mock(() => {}),
    });
  }
  const serve = serveCommands({ apps: served, status, now: () => 1_000 });
  const call = async (name: string, body: unknown) => {
    const request = new Request(`http://bridge${COMMANDS_PATH}${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const response = await serve(request);
    return { status: response.status, answer: (await response.json()) as Answer };
  };
  return { call, apps: served };
}

test.each<[string, string, unknown, number, Answer]>([
  [
    "runs a command for the caller it resolved",
    "status",
    { caller: LEAD, input: {} },
    200,
    { result: { apps: ["default"], channelId: "toybox-link", at: 1_000 }, text: "Linked." },
  ],
  [
    "names each problem with the input the way the CLI shows it",
    "dismiss",
    { caller: LEAD, input: { request: "14" } },
    422,
    {
      error:
        "`dismiss` didn't run. <request>: Write it as inbox shows it, such as r14. --reason: Missing. Run `toy-box-slack dismiss --help` to see what it takes.",
    },
  ],
  [
    "passes on a command's refusal",
    "inbox",
    { caller: LEAD, input: {} },
    409,
    { error: "Run it later." },
  ],
  [
    "refuses a call it can't read without running it",
    "status",
    { caller: { ...LEAD, role: "lead" }, input: {} },
    400,
    {
      error: expect.stringMatching(
        /^The bridge couldn't read the call to `status`, so it didn't run\./,
      ),
    },
  ],
  [
    "serves no command an object inherits",
    "toString",
    { caller: LEAD, input: {} },
    404,
    { error: expect.stringMatching(/^The bridge has no command at \/v1\/commands\/toString\./) },
  ],
])("%s", async (_, name, body, status, answer) => {
  const { call } = await serving();
  expect(await call(name, body)).toEqual({ status, answer });
});

test("runs a command in the app the caller's Toy Box channel links through, else in the default app", async () => {
  const { call } = await serving([
    { name: DEFAULT_APP, links: ["link"] },
    { name: "releases", links: ["other"] },
  ]);
  const ranIn = async (caller: unknown, name = "pause") =>
    (await call(name, { caller, input: {} })).answer.result?.app;

  expect(await ranIn(LEAD)).toBe("default");
  expect(await ranIn({ sessionId: "toybox-other", channelId: null })).toBe("releases");
  expect(await ranIn({ ...TERMINAL, channelId: "toybox-other" })).toBe("releases");
  expect(await ranIn({ ...TERMINAL, channelId: "toybox-new" }, "unlink")).toBe("default");
});

test("shows a terminal that names no channel every app's status, and anyone else one app's", async () => {
  const { call } = await serving([
    { name: DEFAULT_APP, links: ["link"] },
    { name: "releases", links: ["other"] },
  ]);
  const shown = async (caller: unknown) =>
    (await call("status", { caller, input: {} })).answer.result?.apps;

  expect(await shown(TERMINAL)).toEqual(["default", "releases"]);
  expect(await shown({ sessionId: "toybox-other", channelId: null })).toEqual(["releases"]);
  expect(await shown({ ...TERMINAL, channelId: "toybox-link" })).toEqual(["default"]);
});

test("links through the app --app names, refusing one the bridge doesn't run or the channel doesn't link through", async () => {
  const { call } = await serving([
    { name: DEFAULT_APP, links: ["link"] },
    { name: "releases", links: [] },
  ]);
  const link = (channelId: string, app?: string) =>
    call("link", { caller: { ...TERMINAL, channelId }, input: { slackChannel: "C0NEW", app } });

  expect((await link("toybox-new", "releases")).answer.result?.app).toBe("releases");
  expect((await link("toybox-new")).answer.result?.app).toBe("default");
  expect((await link("toybox-link", "default")).answer.result?.app).toBe("default");
  expect(await link("toybox-new", "support")).toEqual({
    status: 409,
    answer: { error: expect.stringMatching(/^The bridge isn't running an app named support,/) },
  });
  expect(await link("toybox-link", "releases")).toEqual({
    status: 409,
    answer: {
      error:
        "This Toy Box channel links through the default app. Run `toy-box-slack unlink` before you link it through the releases app.",
    },
  });
});

test("links a Toy Box channel through only one app when two links race", async () => {
  const linking = (name: string) => ({
    async link() {
      await Bun.sleep(20);
      await createStoredLink(database(name), "new");
      return { result: { app: name }, text: `Linked through the ${name} app.` };
    },
  });
  const { call, apps } = await serving([
    { name: DEFAULT_APP, links: [], handlers: linking(DEFAULT_APP) },
    { name: "releases", links: [], handlers: linking("releases") },
  ]);
  const database = (name: string) => apps.find((app) => app.name === name)!.database;
  const link = (app: string) =>
    call("link", {
      caller: { ...TERMINAL, channelId: "toybox-new" },
      input: { slackChannel: "C0NEW", app },
    });

  const [releases, home] = await Promise.all([link("releases"), link(DEFAULT_APP)]);

  expect(releases).toEqual({
    status: 200,
    answer: { result: { app: "releases" }, text: "Linked through the releases app." },
  });
  expect(home).toEqual({
    status: 409,
    answer: {
      error:
        "This Toy Box channel links through the releases app. Run `toy-box-slack unlink` before you link it through the default app.",
    },
  });
  const linked = (name: string) =>
    database(name).read((sql) => sql`SELECT toybox_channel_id AS id FROM links`);
  expect(await linked("releases")).toEqual([{ id: "toybox-new" }]);
  expect(await linked(DEFAULT_APP)).toEqual([]);
});

test("runs link and resume one at a time, and every other command meanwhile", async () => {
  const linking = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const started: string[] = [];
  const handlers: Partial<AppCommandHandlers> = {
    async link() {
      started.push("link");
      linking.resolve();
      await held.promise;
      return { result: {}, text: "Linked." };
    },
    async resume() {
      started.push("resume");
      return { result: {}, text: "Resumed." };
    },
    async pause() {
      started.push("pause");
      return { result: {}, text: "Paused." };
    },
  };
  const { call } = await serving([
    { name: DEFAULT_APP, links: ["link"], handlers },
    { name: "releases", links: ["other"], handlers },
  ]);
  const terminal = (channelId: string) => ({ ...TERMINAL, channelId });

  const link = call("link", { caller: terminal("toybox-link"), input: { slackChannel: "C0NEW" } });
  await linking.promise;
  const resume = call("resume", { caller: terminal("toybox-other"), input: {} });
  await call("pause", { caller: terminal("toybox-other"), input: {} });
  expect(started).toEqual(["link", "pause"]);

  held.resolve();
  await Promise.all([link, resume]);
  expect(started).toEqual(["link", "pause", "resume"]);
});

test("logs why a command failed under the app it ran in, and says it may or may not have run", async () => {
  const logged = captureLog();
  const { call } = await serving([
    { name: DEFAULT_APP, links: ["link"] },
    { name: "releases", links: ["other"] },
  ]);
  const failed = {
    status: 500,
    answer: {
      error:
        "The bridge couldn't finish `dismiss`, so it may or may not have run. Its log says why. Run `toy-box-slack status` before you try again.",
    },
  };

  expect(await call("dismiss", { caller: LEAD, input: DISMISS })).toEqual(failed);
  const other = { sessionId: "toybox-other", channelId: null };
  expect(await call("dismiss", { caller: other, input: DISMISS })).toEqual(failed);
  const [home, releases] = logged();
  expect(home).toStartWith("Couldn't finish `dismiss`: ");
  expect(home).toContain("error: The disk is full.");
  expect(releases).toStartWith("[releases] Couldn't finish `dismiss`: ");
});

test("reports a change to the app a command ran in, whether it answered, refused or failed", async () => {
  captureLog();
  const { call, apps } = await serving();
  const [app] = apps;

  expect((await call("status", { caller: LEAD, input: {} })).status).toBe(200);
  expect((await call("inbox", { caller: LEAD, input: {} })).status).toBe(409);
  expect((await call("dismiss", { caller: LEAD, input: DISMISS })).status).toBe(500);

  expect(app!.onChange).toHaveBeenCalledTimes(3);
});

test("reports a change only to the apps a command ran in", async () => {
  const { call, apps } = await serving([
    { name: DEFAULT_APP, links: ["link"] },
    { name: "releases", links: ["other"] },
  ]);
  const [home, releases] = apps;

  await call("pause", { caller: { sessionId: "toybox-other", channelId: null }, input: {} });
  expect([home!.onChange.mock.calls.length, releases!.onChange.mock.calls.length]).toEqual([0, 1]);

  await call("status", { caller: TERMINAL, input: {} });
  expect([home!.onChange.mock.calls.length, releases!.onChange.mock.calls.length]).toEqual([1, 2]);
});

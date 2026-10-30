import { expect, onTestFinished, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { Status } from "@commands/model/status";
import { clockTime } from "@commands/model/wording";
import { createStoredLink } from "@links/server/testFixtures";
import { createOutboxWorld, createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import type { BotClient } from "@slackapi/server/botClient";
import { startFakeToyBox } from "../../../../tests/fakes/toybox";
import { statusCommand, type StatusCommandOptions, type StatusSource } from "./status";

const HOUR = 60 * 60_000;
const connected = () => ({ connection: "connected" as const, problem: null });

/** An app whose bridge.db is `database`, connected to Slack, with no bot to name its channels. */
function hosted(
  database: BridgeDatabase,
  name = DEFAULT_APP,
  workspaceUrl: () => string | null = () => null,
) {
  return { name, database, slack: connected, bot: null, workspaceUrl } satisfies StatusSource;
}

/** Status as the bridge runs it, beside a fake Toy Box that has none of the linked channels. */
function startStatus(options: Omit<StatusCommandOptions, "toyBoxOrigin">) {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  return statusCommand({ toyBoxOrigin: new URL(toyBox.url), ...options });
}

/**
 * An app connected to a fake Slack, whose link watches C-link, which Slack calls #toy-box, for the
 * fake Toy Box channel Toy Box Slack.
 */
async function startNamedLink() {
  const { database, slack, bot } = await createOutboxWorld();
  slack.addChannel({ id: "C-link", name: "toy-box" });
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel({ name: "Toy Box Slack" });
  await database.write(
    (transaction) => transaction`UPDATE links SET toybox_channel_id = ${channelId}`,
  );
  return { app: { ...hosted(database), bot }, slack, toyBox, channelId };
}

test("shows only the caller's link, or every link to a terminal that names no channel", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const status = startStatus({ nameApps: false });
  const shown = async (channelId: string | null) => {
    const { result } = await status([hosted(database)], { channelId, at: 1_000 });
    return (result as Status).links.map((link) => link.toyBoxChannelId).toSorted();
  };

  expect(await shown("toybox-link")).toEqual(["toybox-link"]);
  expect(await shown("toybox-other")).toEqual(["toybox-other"]);
  expect(await shown(null)).toEqual(["toybox-link", "toybox-other"]);
});

test("lists the posts Slack never confirmed, linking each answer to its request", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database, { state: "answering" });
  const friday = new Date(2026, 9, 30, 16, 0).getTime();
  const at = friday + 3 * HOUR;
  const app = hosted(database, DEFAULT_APP, () => "https://acme.slack.com/");
  const status = startStatus({ nameApps: false });
  const shown = async () => (await status([app], { channelId: "toybox-link", at })).text;
  const notes = { kind: "publication", request_id: null, thread_ts: null, series: "notes" };
  const unknown = { state: "delivery_unknown", attempt_started_at: at - 2 * HOUR };
  await createStoredOutboxItem(database, 1, { ...notes, scheduled_at: 0, state: "sent" });
  await createStoredOutboxItem(database, 2, { ...notes, scheduled_at: at });
  expect(await shown()).not.toContain("- Posts");

  await createStoredOutboxItem(database, 3, unknown);
  await createStoredOutboxItem(database, 4, { ...notes, ...unknown, scheduled_at: friday });
  expect(await shown()).toContain(
    [
      "- Posts: Slack never confirmed these landed, and the bridge won't send them again. Have the owner check each one. Anyone whose answer is missing can ask again in its thread.",
      "  - o3, the answer to r1, tried 2 hours ago: https://acme.slack.com/archives/C-link/p1700000100000100",
      `  - o4, the notes post for the run scheduled ${clockTime(friday)}, tried 2 hours ago.`,
      "- Wakes:",
    ].join("\n"),
  );
});

test("names each link's channels as Slack and Toy Box call them, beside their IDs", async () => {
  const { app, toyBox, channelId } = await startNamedLink();
  const status = statusCommand({ nameApps: false, toyBoxOrigin: new URL(toyBox.url) });

  const { result, text } = await status([app], { channelId, at: 1_000 });

  expect((result as Status).links).toEqual([
    expect.objectContaining({
      toyBoxChannelId: channelId,
      toyBoxChannel: '"Toy Box Slack"',
      slackChannelId: "C-link",
      slackChannel: "#toy-box",
    }),
  ]);
  expect(text).toContain('\n\n## #toy-box and Toy Box channel "Toy Box Slack"\n');
});

test("waits up to its deadline for a name that takes a moment", async () => {
  const { app, toyBox, channelId } = await startNamedLink();
  const status = statusCommand({ nameApps: false, toyBoxOrigin: new URL(toyBox.url) });
  const unhurried: BotClient = {
    call: async (method, run) => {
      await Bun.sleep(100);
      return app.bot.call(method, run);
    },
  };

  const { text } = await status([{ ...app, bot: unhurried }], { channelId, at: 1_000 });

  expect(text).toContain('\n\n## #toy-box and Toy Box channel "Toy Box Slack"\n');
});

test.each<[string, BotClient["call"]]>([
  ["never answers", () => new Promise(() => {})],
  ["sends what the bridge can't read", () => Promise.reject(new Error("No channel ID."))],
])(
  "shows the Slack channel by its ID within the deadline when Slack %s, still naming the Toy Box channel",
  async (_, call) => {
    const { app, toyBox, channelId } = await startNamedLink();
    const origin = new URL(toyBox.url);
    const status = statusCommand({ nameApps: false, toyBoxOrigin: origin, nameTimeoutMs: 100 });
    const started = performance.now();

    const { text } = await status([{ ...app, bot: { call } }], { channelId, at: 1_000 });

    expect(performance.now() - started).toBeLessThan(500);
    expect(text).toContain('\n\n## #C-link and Toy Box channel "Toy Box Slack"\n');
  },
);

test.each<[string, (toyBox: ReturnType<typeof startFakeToyBox>) => Promise<URL>]>([
  [
    "never answers",
    async () => {
      const silent = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Promise(() => {}),
      });
      onTestFinished(() => silent.stop(true));
      return silent.url;
    },
  ],
  [
    "isn't running",
    async (toyBox) => {
      await toyBox.stop();
      return new URL(toyBox.url);
    },
  ],
])(
  "shows the Toy Box channel by its ID within the deadline when Toy Box %s, still naming the Slack channel",
  async (_, reach) => {
    const { app, toyBox, channelId } = await startNamedLink();
    const origin = await reach(toyBox);
    const status = statusCommand({ nameApps: false, toyBoxOrigin: origin, nameTimeoutMs: 100 });
    const started = performance.now();

    const { text } = await status([app], { channelId, at: 1_000 });

    expect(performance.now() - started).toBeLessThan(500);
    expect(text).toContain(`\n\n## #toy-box and Toy Box channel ${channelId}\n`);
  },
);

test("lets the bridge write while it waits for a channel's name", async () => {
  const { app, toyBox, channelId } = await startNamedLink();
  const status = statusCommand({ nameApps: false, toyBoxOrigin: new URL(toyBox.url) });
  const written = Promise.withResolvers<void>();
  const held: BotClient = {
    call: async (method, run) => {
      await written.promise;
      return app.bot.call(method, run);
    },
  };

  const shown = status([{ ...app, bot: held }], { channelId, at: 1_000 });
  const started = performance.now();
  await app.database.write((transaction) => transaction`SELECT 1`);
  const waited = performance.now() - started;
  written.resolve();
  await shown;

  expect(waited).toBeLessThan(500);
});

test("doesn't ask Slack to name a channel while the app reconnects", async () => {
  const { app, slack, toyBox, channelId } = await startNamedLink();
  const status = statusCommand({ nameApps: false, toyBoxOrigin: new URL(toyBox.url) });
  const reconnecting = () => ({ connection: "reconnecting" as const, problem: null });

  await status([{ ...app, slack: reconnecting }], { channelId, at: 1_000 });

  expect(slack.calls.map(({ method }) => method)).not.toContain("conversations.info");
});

import { expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { Status } from "@commands/model/status";
import { clockTime } from "@commands/model/wording";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { statusCommand, type StatusSource } from "./status";

const HOUR = 60 * 60_000;
const connected = () => ({ connection: "connected" as const, problem: null });

/** An app whose bridge.db is `database`, connected to Slack. */
function hosted(
  database: BridgeDatabase,
  name = DEFAULT_APP,
  workspaceUrl: () => string | null = () => null,
) {
  return { name, database, slack: connected, workspaceUrl } satisfies StatusSource;
}

test("shows only the caller's link, or every link to a terminal that names no channel", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const status = statusCommand({ nameApps: false });
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
  const status = statusCommand({ nameApps: false });
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

test("answers as it did before the bridge hosted several apps while it hosts only the default", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const status = statusCommand({ nameApps: false });

  const { result, text } = await status([hosted(database)], { channelId: null, at: 1_000 });

  expect(Object.keys(result as object)).toEqual(["slack", "links"]);
  expect(text).toStartWith("## Slack\nConnected.");
});

test("names the app of everything it shows once the bridge hosts several", async () => {
  const home = await openTestDatabase();
  const releases = await openTestDatabase();
  await createStoredLink(home);
  await createStoredLink(releases, "other");
  const status = statusCommand({ nameApps: true });
  const apps = [hosted(home), hosted(releases, "releases")];
  const linked = (id: string) => [expect.objectContaining({ toyBoxChannelId: id })];

  const every = await status(apps, { channelId: null, at: 1_000 });
  const one = await status([apps[1]!], { channelId: "toybox-other", at: 1_000 });

  expect(every.result).toEqual({
    apps: [
      { app: "default", slack: connected(), links: linked("toybox-link") },
      { app: "releases", slack: connected(), links: linked("toybox-other") },
    ],
  });
  expect(every.text).toStartWith("# The default app\n\n## Slack\nConnected.");
  expect(every.text).toContain("\n\n# The releases app\n\n## Slack\nConnected.");
  expect(one.result).toEqual({
    apps: [{ app: "releases", slack: connected(), links: linked("toybox-other") }],
  });
  expect(one.text).toStartWith("# The releases app\n\n");
});

import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { CallerRole } from "@commands/model/callers";
import type { Status } from "@commands/model/status";
import { clockTime } from "@commands/model/wording";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { statusCommand } from "./status";

const HOUR = 60 * 60_000;
const connected = () => ({ connection: "connected" as const, problem: null });

test("shows a lead only its own link, and a terminal every link", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const status = statusCommand({ database, slack: connected, workspaceUrl: () => null });
  const shown = async (role: CallerRole, channelId: string | null) => {
    const { result } = await status({}, { caller: { role, channelId }, at: 1_000 });
    return (result as Status).links.map((link) => link.toyBoxChannelId).toSorted();
  };

  expect(await shown("lead", "toybox-link")).toEqual(["toybox-link"]);
  expect(await shown("lead", "toybox-other")).toEqual(["toybox-other"]);
  expect(await shown("terminal", null)).toEqual(["toybox-link", "toybox-other"]);
});

test("lists the posts Slack never confirmed, linking each answer to its request", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database, { state: "answering" });
  const friday = new Date(2026, 9, 30, 16, 0).getTime();
  const at = friday + 3 * HOUR;
  const workspaceUrl = () => "https://acme.slack.com/";
  const status = statusCommand({ database, slack: connected, workspaceUrl });
  const shown = async () =>
    (await status({}, { caller: { role: "lead", channelId: "toybox-link" }, at })).text;
  const notes = { kind: "publication", request_id: null, thread_ts: null, series: "notes" };
  const unknown = { state: "delivery_unknown", unknown_since: at - 2 * HOUR };
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

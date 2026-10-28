import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { CallerRole } from "@commands/model/callers";
import type { Status } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import { statusCommand } from "./status";

test("shows a lead only its own link, and a terminal every link", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const status = statusCommand({
    database,
    slack: () => ({ connection: "connected", problem: null }),
  });
  const shown = async (role: CallerRole, channelId: string | null) => {
    const { result } = await status({}, { caller: { role, channelId }, at: 1_000 });
    return (result as Status).links.map((link) => link.toyBoxChannelId).toSorted();
  };

  expect(await shown("lead", "toybox-link")).toEqual(["toybox-link"]);
  expect(await shown("lead", "toybox-other")).toEqual(["toybox-other"]);
  expect(await shown("terminal", null)).toEqual(["toybox-link", "toybox-other"]);
});

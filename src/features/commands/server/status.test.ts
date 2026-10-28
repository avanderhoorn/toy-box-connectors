import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { statusResultSchema } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import type { WakeDecision } from "@wakes/model";
import { statusCommand } from "./status";

const AT = Date.parse("2026-10-27T16:00:00Z");

test("status adds what the running bridge knows to each link in view", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link");
  await createStoredLink(database, "other");
  const decisions = new Map<string, WakeDecision>([["link", { kind: "wait", until: "lead_idle" }]]);
  const status = statusCommand({
    database,
    origin: new URL("http://127.0.0.1:3000"),
    slack: () => ({ connection: "reconnecting", problem: null }),
    toyBox: {
      view: (channelId) => ({
        connected: channelId === "toybox-link",
        provider: "copilot",
        leadWorking: false,
      }),
    },
    wakes: { decision: (linkId) => decisions.get(linkId) ?? null },
  });

  const all = await status(
    {},
    { caller: { role: "operator", channelId: null, sessionId: null }, at: AT },
  );
  expect(statusResultSchema.parse(all)).toEqual(all);
  expect(all).toMatchObject({
    slack: { connection: "reconnecting", problem: null },
    toyBox: "http://127.0.0.1:3000",
    channelId: null,
  });
  expect(all.links.map(({ id, following, wake }) => ({ id, following, wake }))).toEqual([
    { id: "link", following: true, wake: { kind: "wait", until: "lead_idle" } },
    { id: "other", following: false, wake: null },
  ]);

  const member = await status(
    {},
    { caller: { role: "member", channelId: "toybox-other", sessionId: "agent-reviewer" }, at: AT },
  );
  expect(member.channelId).toBe("toybox-other");
  expect(member.links.map(({ id }) => id)).toEqual(["other"]);
});

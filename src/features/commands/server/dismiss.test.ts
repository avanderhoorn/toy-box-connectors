import { expect, mock, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { dismissCommand } from "./dismiss";
import { refusal } from "./testFixtures";

const LEAD = { channelId: "toybox-link", at: 1_000 };

test("ends a request the lead read, keeping the lead's reason, and says why it can't end it twice", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredRequest(database, { state: "seen" });
  const wakes = { reconsider: mock(() => {}) };
  const dismiss = dismissCommand({ database, wakes });

  expect(await dismiss({ request: 1, reason: "Answered in standup" }, LEAD)).toEqual({
    result: { request: "r1", state: "dismissed" },
    text: "Dismissed r1.",
  });
  expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({
    state: "dismissed",
    closedReason: "Answered in standup",
  });
  expect(wakes.reconsider).toHaveBeenCalledTimes(1);
  expect(await refusal(dismiss({ request: 1, reason: "Done" }, LEAD))).toMatch(
    /^r1 wasn't dismissed\. A request that's dismissed can't .+ Run `toy-box-slack inbox` to see what waits on you\.$/,
  );
});

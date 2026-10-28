import { expect, mock, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { CommandRefusedError } from "@commands/model/protocol";
import { createStoredLink } from "@links/server/testFixtures";
import { serveRequest } from "@requests/model/lifecycle";
import { readRequest, saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { dismissCommand } from "./dismiss";

const LEAD = { caller: { role: "lead", channelId: "toybox-link" }, at: 1_000 } as const;

/** r1 is a request the lead read, and r2 one the other channel's lead read. */
async function startDismissing() {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const mine = await createStoredRequest(database);
  const theirs = await createStoredRequest(database, { linkId: "other", channelId: "C-other" });
  await database.write(async (transaction) => {
    for (const request of [mine, theirs]) await saveRequest(transaction, serveRequest(request, 5));
  });
  const wakes = { reconsider: mock(() => {}) };
  return { database, wakes, dismiss: dismissCommand({ database, wakes }) };
}

async function refusal(answer: Promise<unknown>): Promise<string> {
  const error = await answer.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandRefusedError);
  return (error as Error).message;
}

test("ends a request the lead read, which keeps the lead's reason", async () => {
  const { database, wakes, dismiss } = await startDismissing();

  expect(await dismiss({ request: 1, reason: "Answered in standup" }, LEAD)).toEqual({
    result: { request: "r1", state: "dismissed" },
    text: "Dismissed r1.",
  });
  expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({
    state: "dismissed",
    closedReason: "Answered in standup",
  });
  expect(wakes.reconsider).toHaveBeenCalledTimes(1);
});

test("refuses another channel's request the way it refuses one that doesn't exist", async () => {
  const { database, dismiss } = await startDismissing();

  for (const request of [2, 9]) {
    expect(await refusal(dismiss({ request, reason: "Done" }, LEAD))).toBe(
      `This channel has no request r${request}. Run \`toy-box-slack inbox\` to see what waits on you.`,
    );
  }
  expect(await database.read((sql) => readRequest(sql, 2))).toMatchObject({ state: "seen" });
});

test("says why a request couldn't end", async () => {
  const { dismiss } = await startDismissing();
  await dismiss({ request: 1, reason: "Done" }, LEAD);

  expect(await refusal(dismiss({ request: 1, reason: "Done" }, LEAD))).toMatch(
    /^r1 wasn't dismissed\. A request that's dismissed can't .+ Run `toy-box-slack inbox` to see what waits on you\.$/,
  );
});

import { expect, mock, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { clockTime } from "@commands/model/wording";
import { createStoredLink } from "@links/server/testFixtures";
import { createOutboxWorld } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { publishCommand, replyCommand, retractCommand } from "./posts";
import { refusal } from "./testFixtures";

const LEAD = { role: "lead", channelId: "toybox-link" } as const;

test("reply refuses another channel's request the way it refuses one that doesn't exist", async () => {
  const { database, now } = await createOutboxWorld();
  await createStoredLink(database, "other");
  await createStoredRequest(database, { linkId: "other", channelId: "C-other", state: "seen" });
  const reply = replyCommand({ database, wakes: { reconsider() {} } });

  for (const request of [2, 9]) {
    expect(await refusal(reply({ request, text: "Done." }, { caller: LEAD, at: now() }))).toBe(
      `This channel has no request r${request}. Run \`toy-box-slack inbox\` to see what waits on you.`,
    );
  }
});

test("reply queues one answer in the request's thread, and refuses another by naming it", async () => {
  const { database, now } = await createOutboxWorld();
  const wakes = { reconsider: mock(() => {}) };
  const outbox = { poke: mock(() => {}) };
  const reply = replyCommand({ database, wakes, outbox });
  const lead = { caller: LEAD, at: now() };

  expect(await reply({ request: 1, text: "It's **fixed**." }, lead)).toEqual({
    result: { request: "r1", post: "o1", state: "queued" },
    text: "Queued o1 to answer r1 in its thread. If it can't post, inbox shows r1 again.",
  });
  expect(wakes.reconsider).toHaveBeenCalledTimes(1);
  expect(await refusal(reply({ request: 1, text: "Again." }, lead))).toBe(
    "r1 wasn't answered. Request r1 is already reserved by o1 (queued). Run `toy-box-slack inbox` to see what waits on you.",
  );
  expect(outbox.poke).toHaveBeenCalledTimes(1);
});

test("publish posts once for the latest scheduled run of the routine that runs it", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const routine = {
    id: "notes",
    title: "Release notes",
    schedule: "0 16 * * 5",
    prompt:
      "Draft this week's release notes and post them with `toy-box-slack publish --series notes`.",
  };
  const outbox = { poke: mock(() => {}) };
  const publish = publishCommand({
    database,
    outbox,
    routines: async (channelId) => (channelId === "toybox-link" ? [routine] : null),
  });
  const friday = new Date(2026, 9, 30, 16, 0).getTime();
  const run = `the run of "Release notes" scheduled ${clockTime(friday)}`;

  expect(
    await publish({ series: "notes", text: "# Notes" }, { caller: LEAD, at: friday + 60_000 }),
  ).toEqual({
    result: { post: "o1", series: "notes", scheduledAt: friday, state: "queued" },
    text: `Queued o1 in #C-link for ${run}.`,
  });
  const saturday = { caller: LEAD, at: new Date(2026, 9, 31, 9, 0).getTime() };
  expect(await refusal(publish({ series: "notes", text: "# Again" }, saturday))).toBe(
    `Nothing posted for ${run}. This publication slot is already reserved by o1 (queued).`,
  );
  expect(await refusal(publish({ series: "weekly", text: "# Weekly" }, saturday))).toBe(
    "Nothing posted, because no routine in this channel runs `toy-box-slack publish --series weekly`. Publish posts once for each scheduled run of that routine, so create it first.",
  );
  expect(outbox.poke).toHaveBeenCalledTimes(1);
});

test("retract deletes the lead's post from Slack, and says why when it can't", async () => {
  const world = await createOutboxWorld();
  const { id } = await world.queue();
  await world.post(id);
  const lead = { caller: LEAD, at: world.now() };
  const retract = retractCommand({ database: world.database, bot: world.bot });

  expect(
    await refusal(retractCommand({ database: world.database, bot: null })({ post: 1 }, lead)),
  ).toBe("o1 wasn't deleted. Slack isn't active.");
  expect(await refusal(retract({ post: 2 }, lead))).toBe(
    "o2 wasn't deleted. This is not a known post belonging to this link.",
  );
  expect(await retract({ post: 1 }, lead)).toEqual({
    result: { post: "o1", state: "retracted" },
    text: "Deleted o1 from Slack. Its request or run stays used, so nothing posts in its place.",
  });
  expect(await world.read(id)).toMatchObject({ state: "retracted" });
});

import { describe, expect, onTestFinished, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { FactsNeeded } from "@links/model/setup";
import { createFactsReader } from "@links/server/facts";
import { createBotClient, guardBotClient, type BotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack, type FakeSlack } from "../fakes/slack";
import { startFakeToyBox } from "../fakes/toybox";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const BOT = "UFAKEBOT";

/** A reader over a fake Slack and Toy Box, with its bot client on a fresh database. */
async function startReader({
  pageSize,
  timeoutMs,
  wrap = (bot) => bot,
}: {
  pageSize?: number;
  timeoutMs?: number;
  /** Stands between the reader and the bot client, to see or steer each call. */
  wrap?: (bot: BotClient, slack: FakeSlack) => BotClient;
} = {}) {
  const slack = startFakeSlack({ now: () => NOW, pageSize });
  onTestFinished(() => slack.stop());
  const toyBox = startFakeToyBox({ now: () => NOW });
  onTestFinished(() => toyBox.stop());
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs,
    now: () => NOW,
  });
  const reader = createFactsReader(wrap(bot, slack), new URL(toyBox.url));
  return { slack, toyBox, database, reader };
}

/** A member of the fake's workspace whom users.info vouches for completely. */
function member(id: string, changes: Record<string, unknown> = {}) {
  return {
    id,
    team_id: "TFAKE",
    real_name: `${id} Person`,
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
    ...changes,
  };
}

/** What a change to link C-watch, owned by U-owner, needs. */
function needed(changes: Partial<FactsNeeded> = {}): FactsNeeded {
  return {
    monitored: "C-watch",
    publish: "C-watch",
    owner: "U-owner",
    people: [],
    routineId: "routine",
    ...changes,
  };
}

function methodsCalled(slack: FakeSlack) {
  return slack.calls.map((call) => `${call.method} ${String(call.args.channel ?? call.args.user)}`);
}

const signal = () => AbortSignal.timeout(5_000);

describe("reading Slack for a change", () => {
  test("a local guard leaves facts unverified instead of inventing missing channels or people", async () => {
    let usable = false;
    const { slack, reader } = await startReader({
      wrap: (bot) => guardBotClient(bot, () => usable),
    });
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    expect(await reader.readSlack(needed(), ["U-owner"], signal())).toEqual({
      kind: "unverified",
      detail: "The bridge cannot use Slack for conversations.info right now",
      retryAt: null,
    });
    expect(slack.calls).toEqual([]);
    usable = true;
    expect(await reader.readSlack(needed(), ["U-owner"], signal())).toMatchObject({
      kind: "read",
      facts: { ownerInMonitored: true, ownerInPublish: true },
    });
  });

  test("reads each channel, the people it admits, and whether the owner is in each channel", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", name: "release-eng", is_private: true });
    slack.setMembers("C-watch", [BOT, "U-owner"]);
    slack.addChannel({ id: "C-notes", name: "release-notes" });
    slack.setUser(member("U-carol"));

    const read = await reader.readSlack(
      needed({ publish: "C-notes", people: ["U-carol"] }),
      ["U-owner"],
      signal(),
    );

    expect(read).toEqual({
      kind: "read",
      facts: {
        monitored: expect.objectContaining({ id: "C-watch", name: "release-eng", kind: "private" }),
        publish: expect.objectContaining({ id: "C-notes", name: "release-notes", kind: "public" }),
        ownerInMonitored: true,
        ownerInPublish: false,
        people: [
          {
            userId: "U-carol",
            person: expect.objectContaining({ id: "U-carol", teamId: "TFAKE" }),
          },
        ],
      },
    });
  });

  test("reads a channel the change watches and publishes to once", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });

    const read = await reader.readSlack(needed(), ["U-owner"], signal());

    expect(read).toMatchObject({
      kind: "read",
      facts: { ownerInMonitored: true, ownerInPublish: true, people: [] },
    });
    expect(methodsCalled(slack)).toEqual([
      "conversations.info C-watch",
      "conversations.members C-watch",
    ]);
  });

  test("a channel or person Slack can't find is null, and the owner isn't in a missing channel", async () => {
    const { slack, reader } = await startReader();

    const read = await reader.readSlack(
      needed({ monitored: "C-gone", publish: "C-gone", people: ["U-nobody"] }),
      ["U-owner"],
      signal(),
    );

    expect(read).toEqual({
      kind: "read",
      facts: {
        monitored: null,
        publish: null,
        ownerInMonitored: false,
        ownerInPublish: false,
        people: [{ userId: "U-nobody", person: null }],
      },
    });
    expect(methodsCalled(slack).sort()).toEqual([
      "conversations.info C-gone",
      "users.info U-nobody",
    ]);
  });

  test("doesn't read who's in a channel the bot isn't in", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", is_member: false, members: ["U-owner"] });

    const read = await reader.readSlack(needed(), ["U-owner"], signal());

    expect(read).toMatchObject({
      kind: "read",
      facts: { monitored: { isMember: false }, ownerInMonitored: false },
    });
    expect(methodsCalled(slack)).toEqual(["conversations.info C-watch"]);
  });

  test("the owner counts under any ID they're known by", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "W-owner"] });

    const read = await reader.readSlack(needed(), ["U-owner", "W-owner"], signal());

    expect(read).toMatchObject({ kind: "read", facts: { ownerInMonitored: true } });
  });

  test("a new owner counts under the org-wide ID users.info gives them", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "W-dave"] });
    slack.setUser(member("U-dave", { enterprise_user: { id: "W-dave", enterprise_id: "E-org" } }));

    const handoff = needed({ owner: "U-dave", people: ["U-dave"] });
    const read = await reader.readSlack(handoff, ["U-dave"], signal());

    expect(read).toMatchObject({ kind: "read", facts: { ownerInMonitored: true } });
  });

  test("pages through the members until it finds the owner, past a page with nobody on it", async () => {
    let membersPages = 0;
    const { slack, reader } = await startReader({
      pageSize: 2,
      // Slack may send an empty page with a cursor in the middle of the list.
      wrap: (bot, slack) => ({
        ...bot,
        call: (method, run) => {
          if (method === "conversations.members" && ++membersPages === 2) {
            slack.emptyNextPage(method);
          }
          return bot.call(method, run);
        },
      }),
    });
    slack.addChannel({ id: "C-watch", members: [BOT, "U-a", "U-b", "U-owner", "U-c", "U-d"] });

    const read = await reader.readSlack(needed(), ["U-owner"], signal());

    expect(read).toMatchObject({ kind: "read", facts: { ownerInMonitored: true } });
    // Pages of two: the bot and U-a, nobody, U-b and the owner, and no further.
    expect(membersPages).toBe(3);
  });

  test("the owner isn't in a channel whose every page leaves them out", async () => {
    const { slack, reader } = await startReader({ pageSize: 2 });
    slack.addChannel({ id: "C-watch", members: [BOT, "U-a", "U-b", "U-c", "U-d"] });

    const read = await reader.readSlack(needed(), ["U-owner"], signal());

    expect(read).toMatchObject({ kind: "read", facts: { ownerInMonitored: false } });
    expect(methodsCalled(slack).filter((call) => call.startsWith("conversations.members"))).toEqual(
      Array(3).fill("conversations.members C-watch"),
    );
  });
});

describe("a read that proves nothing", () => {
  test("Slack holding a method back leaves the change unverified until the time it named", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    slack.failNext("conversations.members", { retryAfter: 30 });

    expect(await reader.readSlack(needed(), ["U-owner"], signal())).toEqual({
      kind: "unverified",
      detail: "Slack is holding back conversations.members",
      retryAt: NOW + 30_000,
    });
  });

  test("an error, a rejected token, a lost answer or an unreadable one leaves it unverified", async () => {
    const { slack, reader, database } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    const read = () => reader.readSlack(needed({ people: ["U-carol"] }), ["U-owner"], signal());
    slack.setUser(member("U-carol"));

    slack.failNext("users.info", { error: "missing_scope" });
    expect(await read()).toEqual({
      kind: "unverified",
      detail: "Slack refused users.info with missing_scope",
      retryAt: null,
    });

    slack.failNext("conversations.info", { status: 503 });
    expect(await read()).toEqual({
      kind: "unverified",
      detail: "Slack didn't answer conversations.info: HTTP 503",
      retryAt: null,
    });

    slack.setChannel({ id: "C-watch", is_member: true });
    expect(await read()).toEqual({
      kind: "unverified",
      detail: "Slack answered conversations.info with something the bridge can't read",
      retryAt: null,
    });

    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    slack.failNext("conversations.members", { error: "invalid_auth" });
    expect(await read()).toEqual({
      kind: "unverified",
      detail: "Slack rejected the bot token with invalid_auth",
      retryAt: null,
    });
    const [installation] = await database.read((sql) => sql`SELECT status FROM installation`);
    expect(installation).toEqual({ status: "auth_failed" });
  });

  test("a channel Slack loses while its members are read leaves it unverified", async () => {
    const { slack, reader } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    slack.failNext("conversations.members", { error: "channel_not_found" });

    expect(await reader.readSlack(needed(), ["U-owner"], signal())).toEqual({
      kind: "unverified",
      detail: "Slack lost channel C-watch while reading its members",
      retryAt: null,
    });
  });

  test("a read still waiting when its signal aborts is unverified then", async () => {
    const { slack, reader } = await startReader({ timeoutMs: 30_000 });
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    slack.failNext("conversations.info", { lostResponse: true });
    const started = performance.now();

    expect(await reader.readSlack(needed(), ["U-owner"], AbortSignal.timeout(50))).toEqual({
      kind: "unverified",
      detail: "Slack didn't answer conversations.info in time",
      retryAt: null,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a read whose signal aborted already asks Slack nothing", async () => {
    let calls = 0;
    const { slack, reader } = await startReader({
      wrap: (bot) => ({ ...bot, call: (method, run) => (calls++, bot.call(method, run)) }),
    });
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });

    expect(await reader.readSlack(needed(), ["U-owner"], AbortSignal.abort())).toMatchObject({
      kind: "unverified",
    });
    expect(calls).toBe(0);
  });

  test("a storage error isn't Slack's doing, so it throws", async () => {
    const { slack, reader, database } = await startReader();
    slack.addChannel({ id: "C-watch", members: [BOT, "U-owner"] });
    await database.close();

    await expect(reader.readSlack(needed(), ["U-owner"], signal())).rejects.toThrow();
  });
});

describe("reading the Toy Box channel for a change", () => {
  test("reads the lead's provider, the routines and when the owner last spoke", async () => {
    const { toyBox, reader } = await startReader();
    const channelId = toyBox.addChannel({ provider: "copilot" });
    const routine = toyBox.scheduleRoutine(channelId, {
      title: "Slack requests",
      schedule: "0 9 * * 1-5",
      prompt: "Run `toy-box-slack inbox`.",
    });
    toyBox.postOwnerMessage(channelId, "Link #release-eng");

    expect(await reader.readToyBox(channelId, signal())).toEqual({
      kind: "read",
      facts: { provider: "copilot", ownerSpokeAt: NOW, routines: [routine] },
    });
  });

  test("a channel Toy Box deleted reads as null", async () => {
    const { toyBox, reader } = await startReader();
    const channelId = toyBox.addChannel();
    toyBox.deleteChannel(channelId);

    expect(await reader.readToyBox(channelId, signal())).toEqual({ kind: "read", facts: null });
  });

  test("a Toy Box that refuses the read, or hasn't answered when the signal aborts, leaves it unverified", async () => {
    const { toyBox, reader } = await startReader();
    const channelId = toyBox.addChannel();

    expect(await reader.readToyBox(channelId, AbortSignal.abort())).toEqual({
      kind: "unverified",
      detail: "Toy Box didn't answer in time",
      retryAt: null,
    });
    toyBox.refuseStreams(503);
    expect(await reader.readToyBox(channelId, signal())).toEqual({
      kind: "unverified",
      detail: expect.stringMatching(/^Toy Box couldn't be read: Toy Box answered 503 /),
      retryAt: null,
    });
  });
});

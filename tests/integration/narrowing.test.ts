import { describe, expect, onTestFinished, test } from "bun:test";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import { allowlistField, APPROVAL_LIFETIME_MS } from "@links/model/approvals";
import { pendingApproval } from "@links/model/testFixtures";
import { denyPerson, unlinkChannel } from "@links/server/narrowing";
import type { SetupCaller } from "@links/server/setup";
import { countRows, createStoredApproval, createStoredLink } from "@links/server/testFixtures";
import { renderMarkdown } from "@outbox/model/rendering";
import {
  queueCard,
  queueItem,
  queueReaction,
  readReadyOutbox,
  type OutboxItem,
} from "@outbox/server/database";
import { createPostDelivery } from "@outbox/server/posts";
import { createReactionDelivery } from "@outbox/server/reactions";
import { createRetraction } from "@outbox/server/retract";
import { readRequest, type StoredRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { channelFacts } from "@slackapi/model/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../fakes/slack";

const NOW = 1_700_000_200_000;
const OWNER_TS = "1700000100.000100";
const CAROL_TS = "1700000150.000100";

const lead: SetupCaller = { role: "lead", channelId: "toybox-link" };

/**
 * toybox-link's link to C-link, a private channel of the fake Slack's workspace with the owner,
 * U-carol and the bot in it, which allows U-carol. The clock starts at NOW and moves only when
 * the test or a wait for Slack moves it.
 */
async function linkedChannel() {
  let at = NOW;
  const now = () => at;
  // The fake's workspace and app are the stored installation's.
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  onTestFinished(() => slack.stop());
  slack.addChannel({ id: "C-link", is_private: true, members: ["U-owner", "U-carol", "U-bot"] });
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database);
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), now());
    await transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-carol', 0)
    `;
  });
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs: 1_000,
    now,
  });
  const posts = createPostDelivery(database, bot, { now });
  const reactions = createReactionDelivery(database, bot, { now });
  const retraction = createRetraction(database, bot, { now });

  function deliver(item: OutboxItem) {
    switch (item.kind) {
      case "card":
        return item.phase === "update" ? posts.updateCard(item.id) : posts.post(item.id);
      case "reaction":
        return reactions.react(item.id);
      case "retract":
        return retraction.retract(item.id);
      case "reply":
        return posts.post(item.id);
      default:
        throw new Error(`The test sends no ${item.kind}.`);
    }
  }

  /**
   * Sends what the outbox has ready, as the bridge's sender does, waiting as long as Slack's
   * limits say, until nothing is ready.
   */
  async function send() {
    for (let round = 0; round < 10; round++) {
      const ready = await database.read((sql) => readReadyOutbox(sql, now()));
      if (!ready.length) return;
      let until = at;
      for (const item of ready) {
        const step = await deliver(item);
        if (step.kind === "waiting" && step.until !== null) until = Math.max(until, step.until);
      }
      at = until;
    }
    throw new Error("The outbox still has something ready to send.");
  }

  /**
   * `userId`'s question at `ts`, at the channel's root, which the lead has seen and is answering.
   * Queues 👀 on it.
   */
  async function ask(userId: string, ts: string, text: string) {
    slack.setMessage("C-link", { ts, user: userId, text });
    const request = await createStoredRequest(database, {
      requesterUserId: userId,
      rootTs: ts,
      sourceTs: ts,
      state: "answering",
      servedRev: 1,
      seenAt: now(),
      touchedAt: now(),
    });
    await database.write((transaction) =>
      queueReaction(
        transaction,
        { channelId: "C-link", ts, name: "eyes", linkId: "link", requestId: request.id },
        now(),
      ),
    );
    return request;
  }

  /** Queues the lead's answer to `request`. */
  function answer(request: StoredRequest, text: string) {
    const rendered = renderMarkdown(text);
    if (rendered.kind !== "rendered") throw new Error("The answer needs to render.");
    return database.write((transaction) =>
      queueItem(
        transaction,
        {
          kind: "reply",
          phase: "final",
          linkId: "link",
          requestId: request.id,
          requestRev: request.inputRev,
          channelId: "C-link",
          threadTs: request.rootTs,
          payload: { ...rendered.message },
        },
        now(),
      ),
    );
  }

  /** A card the lead just proposed, allowing `userId`, and its post, queued in C-link. */
  async function propose(userId: string) {
    const field = allowlistField(userId);
    const approval = await createStoredApproval(database, {
      patch: [{ field, after: { label: null } }],
      readSet: { ...pendingApproval().readSet, before: { [field]: null } },
      card: { channelId: "C-link", ts: null },
      createdAt: now(),
      expiresAt: now() + APPROVAL_LIFETIME_MS,
    });
    await database.write((transaction) =>
      queueCard(
        transaction,
        { approvalId: approval.id, linkId: "link", channelId: "C-link", phase: "post" },
        now(),
      ),
    );
    return approval;
  }

  return {
    slack,
    database,
    posts,
    now,
    advance: (ms: number) => {
      at += ms;
    },
    send,
    ask,
    answer,
    propose,
  };
}

/** What a message in Slack says, and the reactions on it. */
function shown(message: { ts: string; text?: unknown; reactions?: unknown }) {
  return { ts: message.ts, text: message.text, reactions: message.reactions ?? [] };
}

describe("unlinking a channel", () => {
  test("withdraws what the bridge owes in it, updates the card it voids, and keeps nothing once Slack settles them", async () => {
    const world = await linkedChannel();
    const carol = await world.ask("U-carol", CAROL_TS, "Can we ship 2.3 today?");
    const owner = await world.ask("U-owner", OWNER_TS, "What changed since 2.2?");
    const card = await world.propose("U-dave");
    await world.send();
    // A second later, Slack puts the owner's answer at the channel's root, and its withdrawal
    // hasn't gone yet.
    world.advance(1_000);
    const misplaced = await world.answer(owner, "Three fixes landed.");
    world.slack.failNext("chat.postMessage", { misplacedReply: true });
    expect(await world.posts.post(misplaced.id)).toMatchObject({ item: { state: "stray" } });
    await world.answer(carol, "Yes, once the last check passes.");
    const before = world.slack.calls.length;

    const outcome = await unlinkChannel(world.database, lead, world.now(), createTestFolder());
    await world.send();

    expect(outcome).toMatchObject({
      kind: "unlinked",
      linkId: "link",
      voided: [{ id: card.id, state: "stale", staleReason: "reversed" }],
      cancelled: [carol.id],
    });
    // Neither answer shows, nor 👀, and the card says the change it asked for was undone.
    const messages = world.slack.getMessages("C-link");
    expect(messages.slice(0, 2).map(shown)).toEqual([
      { ts: OWNER_TS, text: "What changed since 2.2?", reactions: [] },
      { ts: CAROL_TS, text: "Can we ship 2.3 today?", reactions: [] },
    ]);
    expect(messages).toHaveLength(3);
    const blocks = JSON.stringify(messages[2]!.blocks);
    expect(blocks).toContain("a later change undid it");
    expect(blocks).not.toContain('"actions"');
    expect(
      world.slack.calls
        .slice(before)
        .map((call) => call.method)
        .toSorted(),
    ).toEqual(["chat.delete", "chat.update", "reactions.remove", "reactions.remove"]);
    const rows = await countRows(world.database);
    expect(rows).toMatchObject({ links: 0, allowlist: 0, requests: 0, approvals: 0, outbox: 0 });
  });
});

describe("denying someone", () => {
  test("takes 👀 off their question and never sends its answer, while the owner's answer goes", async () => {
    const world = await linkedChannel();
    const carol = await world.ask("U-carol", CAROL_TS, "Can we ship 2.3 today?");
    const owner = await world.ask("U-owner", OWNER_TS, "What changed since 2.2?");
    await world.send();
    await world.answer(carol, "Yes, once the last check passes.");
    await world.answer(owner, "Three fixes landed.");

    const outcome = await denyPerson(world.database, lead, "U-carol", world.now());
    await world.send();

    expect(outcome).toEqual({ kind: "denied", removed: true, voided: [], cancelled: [carol.id] });
    const messages = world.slack.getMessages("C-link");
    expect(messages.find((message) => message.ts === CAROL_TS)?.reactions ?? []).toEqual([]);
    const replies = messages.filter((message) => (message.thread_ts ?? message.ts) !== message.ts);
    expect(replies).toMatchObject([{ thread_ts: OWNER_TS, text: "Three fixes landed." }]);
    expect(await world.database.read((sql) => readRequest(sql, carol.id))).toMatchObject({
      state: "cancelled",
      closedReason: "requester_denied",
    });
    const rows = await countRows(world.database);
    expect(rows).toMatchObject({ allowlist: 0, links: 1 });
  });
});

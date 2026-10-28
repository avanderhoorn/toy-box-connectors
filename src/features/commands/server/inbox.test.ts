import { describe, expect, test } from "bun:test";
import { forgetFile } from "@activity/server/files";
import { ingestMessageEvent } from "@activity/server/ingest";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelCaller } from "@commands/model/callers";
import { inboxContract } from "@commands/model/inbox";
import { pendingApproval } from "@links/model/testFixtures";
import { createStoredApproval, createStoredLink } from "@links/server/testFixtures";
import {
  beginAnswer,
  cancelRequest,
  dismissRequest,
  holdRequest,
  requestLifetimeMs,
  serveRequest,
} from "@requests/model/lifecycle";
import { readRequest, saveRequest, type StoredRequest } from "@requests/server/database";
import { expireRequests } from "@requests/server/lifecycle";
import type { SlackMessage, SlackMessageEvent } from "@slackapi/model/messages";
import {
  askMessage,
  channelFacts,
  editMessage,
  replyMessage,
  slackPerson,
} from "@slackapi/model/testFixtures";
import { writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { writeSlackPerson } from "@slackapi/server/users";
import { inboxCommand } from "./inbox";

const NOW = 1_700_001_000_000;
const AT = 1_700_002_000_000;
const MINUTE = 60_000;

const lead: ChannelCaller = { role: "lead", channelId: "toybox-link", sessionId: "lead-session" };
const ask = askMessage();
const owner = { userId: "U-owner", name: "Alice Chen" };

/**
 * The link `createStoredLink` stores, which allows U-allowed, in an installation U-owner owns, with
 * the names of everyone the tests mention and of the linked channel.
 */
async function openInbox(): Promise<BridgeDatabase> {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await createStoredLink(database);
  await database.write(async (transaction) => {
    await transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-allowed', 0)
    `;
    const people = [
      slackPerson({ id: "U-owner", realName: "Alice Chen" }),
      slackPerson({ id: "U-allowed", realName: "Bob Diaz" }),
      slackPerson({ id: "U-carol", realName: "Carol Chen" }),
      slackPerson({ id: "U-bot", realName: "toy-box", isBot: true }),
    ];
    for (const person of people) await writeSlackPerson(transaction, person, 0);
    await writeChannelInfo(transaction, channelFacts(), 0);
  });
  return database;
}

function ingest(database: BridgeDatabase, event: SlackMessageEvent, now = NOW) {
  return database.write((transaction) =>
    ingestMessageEvent(transaction, event, {
      botUserId: "U-bot",
      ownerUserId: "U-owner",
      late: false,
      now,
    }),
  );
}

function posted(message: SlackMessage): SlackMessageEvent {
  return { kind: "message", message, edit: message.editedTs !== null };
}

/** Inbox for the tests' link, counting how often it asks the wake scheduler to decide again. */
function inboxFor(
  database: BridgeDatabase,
  workspaceUrl: string | null = "https://acme.slack.com/",
) {
  let reconsidered = 0;
  const inbox = inboxCommand({
    database,
    wakes: { reconsider: () => void reconsidered++ },
    workspaceUrl: () => workspaceUrl,
  });
  return {
    read: (caller = lead, at = AT, limit = 10) => inbox({ limit }, { caller, at }),
    reconsidered: () => reconsidered,
  };
}

function readWakeState(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT last_inbox_at, wakes_since_inbox FROM wake_state WHERE link_id = 'link'`,
  );
}

/** Applies a lifecycle step to stored request `id`, without anything else the bridge would do. */
function change(
  database: BridgeDatabase,
  id: number,
  step: (request: StoredRequest) => StoredRequest,
) {
  return database.write(async (transaction) => {
    const request = await readRequest(transaction, id);
    await saveRequest(transaction, step(request!));
  });
}

function deleted(message: SlackMessage): SlackMessageEvent {
  return { kind: "deleted", channelId: message.channelId, ts: message.ts };
}

describe("reading requests", () => {
  test("shows a new request with every message it holds, and serves it at that revision", async () => {
    const database = await openInbox();
    await ingest(database, posted(ask));
    await ingest(database, posted(replyMessage(ask, "1700000160.000100")));
    await database.write(
      (transaction) => transaction`
        INSERT INTO wake_state (link_id, last_wake_at, wakes_since_inbox) VALUES ('link', ${NOW}, 3)
      `,
    );
    const inbox = inboxFor(database);

    expect(await inbox.read()).toEqual({
      linked: true,
      settings: [],
      requests: [
        {
          id: 1,
          revision: 2,
          requester: { ...owner, role: "owner" },
          askedAt: 1_700_000_100_000,
          attention: null,
          unverified: false,
          permalink: "https://acme.slack.com/archives/C-link/p1700000100000100",
          messages: [
            {
              ts: "1700000100.000100",
              state: "posted",
              text: "{toy-box} can you look at the deploy?",
              files: [],
            },
            {
              ts: "1700000160.000100",
              state: "posted",
              text: "it fails on the migration step",
              files: [],
            },
          ],
          earlier: 0,
          later: 0,
        },
      ],
      more: 0,
      waiting: [],
      moreWaiting: 0,
      ended: [],
      moreEnded: 0,
    });
    expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({
      state: "seen",
      inputRev: 2,
      servedRev: 2,
      seenAt: AT,
      attention: null,
    });
    // Reading ends the stall the unanswered wakes built up.
    expect(await readWakeState(database)).toEqual([{ last_inbox_at: AT, wakes_since_inbox: 0 }]);
    expect(inbox.reconsidered()).toBe(1);

    const again = await inbox.read(lead, AT + MINUTE);
    expect(again.requests).toEqual([]);
    expect(again.waiting).toEqual([
      {
        id: 1,
        revision: 2,
        requester: { ...owner, role: "owner" },
        state: "seen",
        askedAt: 1_700_000_100_000,
        heldAt: null,
        snippet: "can you look at the deploy?",
      },
    ]);
    expect(await readWakeState(database)).toEqual([
      { last_inbox_at: AT + MINUTE, wakes_since_inbox: 0 },
    ]);
  });

  test("shows a request again once it changes, and leaves one being answered to the outbox", async () => {
    const database = await openInbox();
    const reply = replyMessage(ask, "1700000160.000100");
    await ingest(database, posted(ask));
    await ingest(database, posted(reply));
    await ingest(database, posted(askMessage("1700000300.000100", { userId: "U-allowed" })));
    const inbox = inboxFor(database);
    await inbox.read();
    await database.write(async (transaction) => {
      const request = await readRequest(transaction, 2);
      await saveRequest(transaction, beginAnswer(request!, AT));
    });

    const edit = "<@U-bot> can you look at the deploy on staging?";
    await ingest(database, posted(editMessage(ask, "1700000200.000100", edit)), AT + MINUTE);
    await ingest(database, { kind: "deleted", channelId: "C-link", ts: reply.ts }, AT + MINUTE);
    const changed = await inbox.read(lead, AT + 2 * MINUTE);

    expect(changed.requests).toMatchObject([
      {
        id: 1,
        revision: 4,
        attention: "updated",
        messages: [
          { ts: ask.ts, state: "edited", text: "{toy-box} can you look at the deploy on staging?" },
          { ts: reply.ts, state: "deleted", text: null },
        ],
      },
    ]);
    expect(changed.waiting).toEqual([]);
    expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({
      state: "seen",
      servedRev: 4,
      attention: null,
    });
  });

  test("keeps each list to the limit, oldest change first, and serves only what it shows", async () => {
    const database = await openInbox();
    await ingest(database, posted(askMessage("1700000100.000100")), NOW);
    await ingest(database, posted(askMessage("1700000200.000100")), NOW + 1);
    await ingest(database, posted(askMessage("1700000300.000100")), NOW + 2);
    const edit = editMessage(ask, "1700000400.000100", "<@U-bot> and the logs?");
    await ingest(database, posted(edit), NOW + 3);

    const inbox = inboxFor(database);
    const first = await inbox.read(lead, AT, 2);
    expect(first.requests.map(({ id }) => id)).toEqual([2, 3]);
    expect(first.more).toBe(1);
    expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({ state: "open" });

    const second = await inbox.read(lead, AT + MINUTE, 2);
    expect(second.requests.map(({ id }) => id)).toEqual([1]);
    expect(second.more).toBe(0);
    expect(second.waiting.map(({ id }) => id)).toEqual([2, 3]);
  });

  test("reads a requester's role, names, files and thread as they are now", async () => {
    const database = await openInbox();
    const stranger = { userId: "U-stranger", mentions: [], mentionsBot: false };
    const root = askMessage("1700000100.000100", { ...stranger, text: "the deploy is stuck" });
    const asked = replyMessage(root, "1700000200.000100", {
      userId: "U-allowed",
      text: "<@U-bot> is it <#C-link> again? <@U-owner> saw it too",
      mentions: ["U-bot", "U-owner"],
      mentionsBot: true,
      files: [
        { id: "F1", name: "deploy.log", mimetype: "text/plain", size: 49_152 },
        { id: "F2", name: "old.log", mimetype: "text/plain", size: 10 },
      ],
    });
    const agreed = replyMessage(root, "1700000300.000100", { ...stranger, text: "+1" });
    const followed = replyMessage(root, "1700000400.000100", {
      userId: "U-allowed",
      text: "and on staging",
    });
    const gone = replyMessage(root, "1700000500.000100", { ...stranger, text: "oops" });
    const thanked = replyMessage(root, "1700000600.000100", { ...stranger, text: "thanks" });
    for (const message of [root, asked, agreed, followed, gone, thanked]) {
      await ingest(database, posted(message));
    }
    await ingest(database, { kind: "deleted", channelId: "C-link", ts: gone.ts });
    // Slack deleted F2, and the ledger forgot it while the message still names it.
    await database.write((transaction) => forgetFile(transaction, "F2"));

    const [request] = (await inboxFor(database).read()).requests;
    expect(request).toMatchObject({
      requester: { userId: "U-allowed", name: "Bob Diaz", role: "allowed" },
      permalink:
        "https://acme.slack.com/archives/C-link/p1700000200000100?thread_ts=1700000100.000100",
      messages: [
        {
          ts: asked.ts,
          text: "{toy-box} is it #toy-box-private again? {Alice Chen} saw it too",
          files: [{ id: "F1", name: "deploy.log", size: 49_152 }],
        },
        { ts: followed.ts, text: "and on staging", files: [] },
      ],
      // The root and the +1 came before the follow-up and the thanks after it. The deleted one is gone.
      earlier: 2,
      later: 1,
    });
  });

  test("links to a request in Slack once the workspace's address is known", async () => {
    const database = await openInbox();
    await ingest(database, posted(ask));

    const [request] = (await inboxFor(database, "https://acme.slack.com").read()).requests;
    expect(request?.permalink).toBe("https://acme.slack.com/archives/C-link/p1700000100000100");
  });

  test("shows the owner's request as no longer allowed once they hand ownership on", async () => {
    const database = await openInbox();
    await ingest(database, posted(ask));
    const inbox = inboxFor(database);
    await inbox.read();
    await database.write(
      (transaction) => transaction`UPDATE installation SET owner_user_id = 'U-carol'`,
    );

    const [waiting] = (await inbox.read(lead, AT + MINUTE)).waiting;
    expect(waiting?.requester).toEqual({ ...owner, role: "not_allowed" });
  });

  test("lists a request the lead holds for the owner with when it held it", async () => {
    const database = await openInbox();
    await ingest(database, posted(ask));
    const inbox = inboxFor(database);
    await inbox.read();
    await database.write(async (transaction) => {
      const request = await readRequest(transaction, 1);
      await saveRequest(transaction, holdRequest(request!, "asked Alice", AT));
    });

    const [waiting] = (await inbox.read(lead, AT + MINUTE)).waiting;
    expect(waiting).toMatchObject({ id: 1, state: "seen", heldAt: AT });
  });

  test("shows a source Slack withdrew as hidden and unconfirmed, without quoting it", async () => {
    const database = await openInbox();
    const reply = replyMessage(ask, "1700000160.000100");
    const alone = askMessage("1700000300.000100", { userId: "U-allowed" });
    for (const message of [ask, reply, alone]) await ingest(database, posted(message));
    for (const { ts } of [ask, alone]) {
      await ingest(database, { kind: "withdrawn", channelId: "C-link", ts });
    }
    const inbox = inboxFor(database, null);

    expect((await inbox.read()).requests).toMatchObject([
      {
        id: 1,
        unverified: true,
        permalink: null,
        messages: [
          { ts: ask.ts, state: "withdrawn", text: null, files: [] },
          { ts: reply.ts, state: "posted", text: "it fails on the migration step" },
        ],
      },
      { id: 2, unverified: true, messages: [{ ts: alone.ts, state: "withdrawn", text: null }] },
    ]);
    // A waiting request quotes its first message that has text, or nothing when none has any.
    const { waiting } = await inbox.read(lead, AT + MINUTE);
    expect(waiting.map(({ snippet }) => snippet)).toEqual(["it fails on the migration step", ""]);
  });

  test("marks nothing read when its answer can't be given", async () => {
    const database = await openInbox();
    await ingest(database, posted(ask));
    await ingest(database, posted(askMessage("1700000300.000100", { userId: "U-allowed" })));
    await change(database, 2, (request) =>
      cancelRequest(serveRequest(request, NOW), "requester_denied"),
    );
    await createStoredApproval(database, {
      state: "rejected",
      decidedBy: "U-owner",
      decidedAt: NOW,
    });
    await database.write(
      (transaction) => transaction`
        UPDATE messages SET files = '[{"id":"F1","name":"x","mimetype":null,"size":-1}]'
      `,
    );
    await database.write(
      (transaction) => transaction`
        INSERT INTO files (file_id, channel_id, ts, state) VALUES ('F1', 'C-link', ${ask.ts}, 'indexed')
      `,
    );
    const inbox = inboxFor(database);

    await expect(inbox.read()).rejects.toThrow();
    expect(await database.read((sql) => readRequest(sql, 1))).toMatchObject({ state: "open" });
    expect(await database.read((sql) => sql`SELECT reported_at FROM approvals`)).toEqual([
      { reported_at: null },
    ]);
    expect(await database.read((sql) => sql`SELECT closed_reported_at FROM requests`)).toEqual([
      { closed_reported_at: null },
      { closed_reported_at: null },
    ]);
    expect(await readWakeState(database)).toEqual([]);
    expect(inbox.reconsidered()).toBe(0);
  });
});

describe("reporting requests that ended", () => {
  test("tells the lead once, oldest first, which requests it read were cancelled or expired", async () => {
    const database = await openInbox();
    const bobs = askMessage("1700000300.000100", { userId: "U-allowed" });
    await ingest(database, posted(ask));
    await ingest(database, posted(bobs));
    await ingest(database, posted(askMessage("1700000500.000100")), NOW + MINUTE);
    const inbox = inboxFor(database);
    await inbox.read();
    await ingest(database, deleted(bobs), AT + MINUTE);
    const expiry = NOW + requestLifetimeMs;
    await database.write((transaction) => expireRequests(transaction, expiry));

    const result = await inbox.read(lead, expiry + MINUTE);
    expect(result.ended).toEqual([
      { id: 1, requester: owner, state: "expired", reason: null },
      {
        id: 2,
        requester: { userId: "U-allowed", name: "Bob Diaz" },
        state: "cancelled",
        reason: "source_deleted",
      },
    ]);
    expect(result.moreEnded).toBe(0);
    expect(result.waiting.map(({ id }) => id)).toEqual([3]);
    expect(
      await database.read((sql) => sql`SELECT id, closed_reported_at FROM requests ORDER BY id`),
    ).toEqual([
      { id: 1, closed_reported_at: expiry + MINUTE },
      { id: 2, closed_reported_at: expiry + MINUTE },
      { id: 3, closed_reported_at: null },
    ]);
    expect((await inbox.read(lead, expiry + 2 * MINUTE)).ended).toEqual([]);
  });

  test("says nothing of one the lead never read or dismissed, or of another channel's", async () => {
    const database = await openInbox();
    await createStoredLink(database, "other");
    const others = askMessage("1700000200.000100", { channelId: "C-other" });
    const unread = askMessage("1700000300.000100");
    await ingest(database, posted(ask));
    await ingest(database, posted(others));
    const inbox = inboxFor(database);
    await inbox.read();
    await change(database, 2, (request) => serveRequest(request, AT));
    await ingest(database, posted(unread), AT);
    await change(database, 1, (request) => dismissRequest(request, "Answered in the standup"));
    await ingest(database, deleted(others), AT);
    await ingest(database, deleted(unread), AT);

    expect(
      await database.read((sql) => sql`SELECT id, link_id, state, seen_at FROM requests`),
    ).toEqual([
      { id: 1, link_id: "link", state: "dismissed", seen_at: AT },
      { id: 2, link_id: "other", state: "cancelled", seen_at: AT },
      { id: 3, link_id: "link", state: "cancelled", seen_at: null },
    ]);
    expect(await inbox.read(lead, AT + MINUTE)).toMatchObject({ ended: [], moreEnded: 0 });
    const elsewhere = await inbox.read({ ...lead, channelId: "toybox-other" }, AT + MINUTE);
    expect(elsewhere.ended.map(({ id }) => id)).toEqual([2]);
  });

  test("reports at most the limit, and leaves the rest for the next inbox", async () => {
    const database = await openInbox();
    const asks = ["1700000100.000100", "1700000200.000100", "1700000300.000100"].map((ts) =>
      askMessage(ts),
    );
    for (const message of asks) await ingest(database, posted(message));
    const inbox = inboxFor(database);
    await inbox.read();
    for (const message of asks) await ingest(database, deleted(message), AT);

    const first = await inbox.read(lead, AT + MINUTE, 2);
    expect(first.ended.map(({ id }) => id)).toEqual([1, 2]);
    expect(first.moreEnded).toBe(1);
    const second = await inbox.read(lead, AT + 2 * MINUTE, 2);
    expect(second.ended.map(({ id }) => id)).toEqual([3]);
    expect(second.moreEnded).toBe(0);
  });
});

describe("reporting settings", () => {
  test("reports each proposal that ended once, oldest first, and only to its own channel", async () => {
    const database = await openInbox();
    await createStoredApproval(database, {
      id: "approval-1",
      number: 1,
      state: "applied",
      appliedAt: NOW,
      decidedBy: "U-owner",
      decidedAt: NOW,
    });
    await createStoredApproval(database, { id: "approval-2", number: 2 });
    await createStoredApproval(database, {
      id: "approval-3",
      number: 3,
      action: "set",
      patch: [
        { field: "request_mode", after: "all" },
        { field: "observe", after: "channel" },
        { field: "publish_channel_id", after: "C-news" },
      ],
      state: "expired",
    });
    await createStoredApproval(database, {
      id: "approval-4",
      number: 4,
      action: "owner",
      patch: [{ field: "owner_user_id", after: "U-carol" }],
      state: "stale",
      staleReason: "reversed",
      decidedBy: "U-owner",
      decidedAt: NOW,
    });
    await createStoredApproval(database, {
      id: "approval-6",
      number: 6,
      action: "resume",
      patch: [{ field: "status", after: "active" }],
      state: "rejected",
      decidedBy: "U-owner",
      decidedAt: NOW,
    });
    await createStoredLink(database, "other");
    await createStoredApproval(database, {
      id: "approval-5",
      number: 5,
      toyboxChannelId: "toybox-other",
      linkId: "other",
      state: "rejected",
      decidedBy: "U-owner",
      decidedAt: NOW,
    });
    const inbox = inboxFor(database);

    const { settings } = await inbox.read();
    expect(settings).toEqual([
      {
        approval: 1,
        action: "allow",
        state: "applied",
        owner,
        decidedBy: owner,
        staleReason: null,
        changes: [{ kind: "allow", person: { userId: "U-carol", name: "Carol Chen" } }],
      },
      {
        approval: 3,
        action: "set",
        state: "expired",
        owner,
        decidedBy: null,
        staleReason: null,
        changes: [
          { kind: "requests", mode: "all" },
          { kind: "observe", mode: "channel" },
          // The bridge hasn't read the channel, so it has no name to show.
          { kind: "publish", channel: { id: "C-news", name: null } },
        ],
      },
      {
        approval: 4,
        action: "owner",
        state: "stale",
        owner,
        decidedBy: owner,
        staleReason: "reversed",
        changes: [{ kind: "owner", person: { userId: "U-carol", name: "Carol Chen" } }],
      },
      {
        approval: 6,
        action: "resume",
        state: "rejected",
        owner,
        decidedBy: owner,
        staleReason: null,
        changes: [{ kind: "resume" }],
      },
    ]);
    expect(
      await database.read((sql) => sql`SELECT number, reported_at FROM approvals ORDER BY number`),
    ).toEqual([
      { number: 1, reported_at: AT },
      { number: 2, reported_at: null },
      { number: 3, reported_at: AT },
      { number: 4, reported_at: AT },
      { number: 5, reported_at: null },
      { number: 6, reported_at: AT },
    ]);
    expect((await inbox.read(lead, AT + MINUTE)).settings).toEqual([]);
  });

  test("an unlinked channel learns how its proposals ended, and nothing else", async () => {
    const database = await openInbox();
    await createStoredApproval(database, {
      toyboxChannelId: "toybox-new",
      linkId: null,
      action: "link",
      readSet: { ...pendingApproval().readSet, link: "none", before: {} },
      patch: [
        { field: "slack_channel_id", after: "C-link" },
        { field: "publish_channel_id", after: "C-link" },
        { field: "request_mode", after: "mention" },
        { field: "observe", after: "requesters" },
        { field: "requests_routine_id", after: "routine-new" },
        { field: "allowlist.U-carol", after: { label: null } },
      ],
      state: "rejected",
      decidedBy: "U-owner",
      decidedAt: NOW,
    });
    const inbox = inboxFor(database);
    const caller: ChannelCaller = { ...lead, channelId: "toybox-new" };

    const result = await inbox.read(caller);
    expect(result).toEqual({
      linked: false,
      settings: [
        {
          approval: 1,
          action: "link",
          state: "rejected",
          owner,
          decidedBy: owner,
          staleReason: null,
          changes: [
            { kind: "watch", channel: { id: "C-link", name: "toy-box-private" } },
            { kind: "publish", channel: { id: "C-link", name: "toy-box-private" } },
            { kind: "requests", mode: "mention" },
            { kind: "observe", mode: "requesters" },
            { kind: "allow", person: { userId: "U-carol", name: "Carol Chen" } },
          ],
        },
      ],
      requests: [],
      more: 0,
      waiting: [],
      moreWaiting: 0,
      ended: [],
      moreEnded: 0,
    });
    expect(inboxContract.present(result, { at: AT })).toBe(
      [
        "## Settings",
        "- a1 rejected by Alice Chen: link #toy-box-private, and let Carol Chen ask for help",
        "",
        "This Toy Box channel isn't linked to Slack. Run `toy-box-slack link --slack-channel <id> --routine <id>` to link it.",
      ].join("\n"),
    );
    expect(await readWakeState(database)).toEqual([]);
    expect(inbox.reconsidered()).toBe(1);
  });
});

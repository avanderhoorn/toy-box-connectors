import { expect, test } from "bun:test";
import { createStoredMessage } from "@activity/server/testFixtures";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { failQueuedItem, queueReply } from "@outbox/server/database";
import { dismissRequest, serveRequest } from "@requests/model/lifecycle";
import { saveRequest } from "@requests/server/database";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage, sharedFile } from "@slackapi/model/testFixtures";
import { inboxCommand } from "./inbox";

const LEAD = { channelId: "toybox-link" };

/** The request asked at the root of a thread of its own. */
function askedAt(thread: number) {
  return { rootTs: `1700000100.00010${thread}`, sourceTs: `1700000100.00010${thread}` };
}

test("shows changed requests first, up to its limit, and marks only those it showed read", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await createStoredLink(database, "other");
  const read = await createStoredRequest(database, askedAt(1));
  await createStoredRequest(database, { ...askedAt(2), changedAt: 30 });
  const updated = await createStoredRequest(database, askedAt(3));
  const dismissed = await createStoredRequest(database, askedAt(4));
  await createStoredRequest(database, { ...askedAt(5), linkId: "other", channelId: "C-other" });
  await database.write(async (transaction) => {
    await saveRequest(transaction, serveRequest(read, 5));
    await saveRequest(transaction, {
      ...serveRequest(updated, 5),
      attention: "updated",
      changedAt: 20,
    });
    await saveRequest(transaction, dismissRequest(serveRequest(dismissed, 5), "Done"));
  });
  const acknowledged: string[][] = [];
  const inbox = inboxCommand({
    database,
    workspaceUrl: () => null,
    acknowledge: (requests) => acknowledged.push(requests.map(({ sourceTs }) => sourceTs)),
  });

  const first = await inbox({ limit: 1 }, { ...LEAD, at: 1_000 });
  const second = await inbox({ limit: 10 }, { ...LEAD, at: 2_000 });

  expect(first.result).toMatchObject({ requests: [{ id: 3 }], more: 2 });
  // The open request stayed unread until an inbox showed it.
  expect(second.result).toMatchObject({ requests: [{ id: 2 }, { id: 1 }, { id: 3 }], more: 0 });
  const stored = await database.read(
    (sql) => sql`SELECT id, state, attention, touched_at AS touchedAt FROM requests ORDER BY id`,
  );
  expect([...stored]).toEqual([
    { id: 1, state: "seen", attention: null, touchedAt: 5 },
    { id: 2, state: "seen", attention: null, touchedAt: 2_000 },
    { id: 3, state: "seen", attention: null, touchedAt: 1_000 },
    { id: 4, state: "dismissed", attention: null, touchedAt: 5 },
    { id: 5, state: "open", attention: null, touchedAt: null },
  ]);
  expect(acknowledged).toEqual([[askedAt(3).sourceTs], [askedAt(2).sourceTs]]);
});

test.each([
  ["names the Slack channel Slack last gave the link", "toy-box", "#toy-box"],
  ["names a link made before it stored a name by the channel's ID", null, "#C-link"],
])("%s", async (_, name, shown) => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", { slack_channel_name: name });
  await createStoredRequest(database, askedAt(1));
  const inbox = inboxCommand({ database, workspaceUrl: () => null });

  const { result, text } = await inbox({ limit: 10 }, { ...LEAD, at: 1_000 });

  expect(result).toMatchObject({ channel: shown });
  expect(text).toContain(`1 request in ${shown} waits on you.`);
});

test("says why each request's reply didn't post", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  const widened = await createStoredRequest(database, { ...askedAt(1), state: "seen" });
  const refused = await createStoredRequest(database, { ...askedAt(2), state: "seen" });
  await database.write(async (transaction) => {
    await transaction`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)`;
    for (const [request, error] of [
      [widened, "audience_widened"],
      [refused, "invalid_blocks"],
    ] as const) {
      const reply = await queueReply(transaction, { requestId: request.id, text: "Done." }, 10);
      await failQueuedItem(transaction, reply, error, 20);
    }
  });
  const inbox = inboxCommand({ database, workspaceUrl: () => null });

  const { result } = await inbox({ limit: 10 }, { ...LEAD, at: 1_000 });

  expect(result).toMatchObject({
    requests: [
      { id: 1, attention: "reply_failed", replyError: "audience_widened" },
      { id: 2, attention: "reply_failed", replyError: "invalid_blocks" },
    ],
  });
});

test("lists the files each message shares in the order it shares them, and why the lead can't read one", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database);
  await database.write(
    (transaction) =>
      transaction`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)`,
  );
  const notes = sharedFile("F-notes", { name: "notes.txt", mimeType: "text/plain", size: 2_048 });
  const forwarded = sharedFile("F-shot", { uploaderId: "U-mallory" });
  await createStoredMessage(database, askMessage(undefined, { files: [notes, forwarded] }));
  await createStoredRequest(database);
  const inbox = inboxCommand({ database, workspaceUrl: () => null });

  const { result } = await inbox({ limit: 10 }, { ...LEAD, at: 1_000 });

  expect(result).toMatchObject({
    requests: [
      {
        messages: [
          {
            files: [
              { reference: "f1", format: "text", size: 2_048, name: "notes.txt" },
              {
                reason: "whoever uploaded it isn't on the allowlist",
                size: 412_000,
                name: "build-error.png",
              },
            ],
          },
        ],
      },
    ],
  });
});

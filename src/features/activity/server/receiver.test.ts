import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACK_DEADLINE_MS, type SlackDelivery } from "@activity/model/receiver";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readFrame } from "@slackapi/model/envelopes";
import { channelFacts, slackPerson } from "@slackapi/model/testFixtures";
import { readChannelInfo, recordChannelAlias, writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { writeSlackPerson } from "@slackapi/server/users";
import { startSlackReceiver, type SlackReceiverOptions } from "./receiver";

const arrivedAt = 1_700_001_000_000;
const committedAt = arrivedAt + 100;

/** The gap an event that happened at 1700000900 and arrived at `arrivedAt` leaves. */
const eventGap = { oldest_ts: "1700000600.000000", latest_ts: "1700001300.000000" };

/** Our bot's authorization, as Slack lists it on an event for our installation. */
const ourBot = {
  enterprise_id: null,
  team_id: "T-home",
  user_id: "U0BOT",
  is_bot: true,
  is_enterprise_install: false,
};

type ReceiverSetup = Partial<SlackReceiverOptions> & {
  /** The stored installation's columns, or null for none. */
  installation?: Parameters<typeof createStoredInstallation>[1] | null;
};

/**
 * A receiver for the installation whose bot is U0BOT, which link watches in C-link for U-alice. It
 * commits everything at `committedAt`, and records what it acks and how often it reports a change.
 */
async function openReceiver({ installation = {}, ...options }: ReceiverSetup = {}) {
  const folder = createTestFolder();
  const path = join(folder, "bridge.db");
  const database = await openBridgeDatabase(path);
  onTestFinished(() => database.close());
  if (installation !== null) {
    await createStoredInstallation(database, { bot_user_id: "U0BOT", ...installation });
  }
  await createStoredLink(database);
  await database.write(
    (transaction) => transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-alice', 0)
    `,
  );
  const filesFolder = join(folder, "files");
  mkdirSync(filesFolder);
  let changes = 0;
  const receiver = startSlackReceiver(database, {
    filesFolder,
    onChange: () => (changes += 1),
    now: () => committedAt,
    ...options,
  });
  onTestFinished(() => receiver.stop());
  const acks: string[] = [];
  return {
    database,
    path,
    filesFolder,
    receiver,
    acks,
    changes: () => changes,
    receive: (delivery: SlackDelivery, at = arrivedAt) =>
      receiver.receive(delivery, at, (envelopeId) => acks.push(envelopeId)),
  };
}

function delivery(frame: unknown): SlackDelivery {
  const read = readFrame(typeof frame === "string" ? frame : JSON.stringify(frame));
  if (read.kind === "hello" || read.kind === "disconnect") throw new Error("Not a delivery.");
  return read;
}

/** Event `id` as Slack frames it, which happened at 1700000900. `payload` replaces callback fields. */
function eventFrame(id: string, event: object, payload: object = {}): SlackDelivery {
  return delivery({
    type: "events_api",
    envelope_id: `env-${id}`,
    payload: {
      type: "event_callback",
      team_id: "T-home",
      api_app_id: "A-app",
      event_id: `Ev-${id}`,
      event_time: 1_700_000_900,
      authorizations: [ourBot],
      event,
      ...payload,
    },
  });
}

type RawMessage = { channel: string; ts: string; text: string; [field: string]: unknown };

/** A message U-alice posted in C-link at `ts`. `changes` replace its fields. */
function message(ts: string, text: string, changes: Record<string, unknown> = {}): RawMessage {
  return {
    type: "message",
    channel: "C-link",
    user: "U-alice",
    team: "T-home",
    text,
    ts,
    ...changes,
  };
}

/** Slack's event for a message as it is after an edit, or after its thread changed. */
function changed({ channel, ...snapshot }: RawMessage) {
  return { type: "message", subtype: "message_changed", channel, hidden: true, message: snapshot };
}

/** Slack's event for C-link's move from `oldId` to `newId`. */
function moved(oldId: string, newId: string) {
  return {
    type: "channel_id_changed",
    old_channel_id: oldId,
    new_channel_id: newId,
    event_ts: "1700000900.000100",
  };
}

function deleted(ts: string, previous: object = {}) {
  return {
    type: "message",
    subtype: "message_deleted",
    channel: "C-link",
    hidden: true,
    deleted_ts: ts,
    previous_message: previous,
  };
}

/** The tombstone Slack leaves where `root` was, once it's deleted with replies still under it. */
function tombstoneOf(root: RawMessage, replies: number): RawMessage {
  return {
    type: "message",
    subtype: "tombstone",
    channel: root.channel,
    user: "USLACKBOT",
    text: "This message was deleted.",
    ts: root.ts,
    thread_ts: root.ts,
    reply_count: replies,
    hidden: true,
  };
}

/** `posted` as Slack shows it once an admin revokes its key. */
function revokedOf(posted: RawMessage): RawMessage {
  return {
    type: "message",
    subtype: "ekm_access_denied",
    channel: posted.channel,
    user: "UREVOKEDU",
    text: "Your admins have suspended everyone's access to this content.",
    ts: posted.ts,
  };
}

function file(id: string) {
  return { id, name: `${id}.png`, mimetype: "image/png", size: 2048 };
}

/** Marks every indexed file fetched, with a local copy named by its ID. */
async function fetchFiles(database: BridgeDatabase, filesFolder: string) {
  const fetched = await database.write(
    (transaction) => transaction<{ file_id: string }[]>`
      UPDATE files SET state = 'fetched', local_path = file_id || '.png', fetched_at = 1
      RETURNING file_id
    `,
  );
  for (const { file_id } of fetched) writeFileSync(join(filesFolder, `${file_id}.png`), "png");
}

function readMessages(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT channel_id, ts, text, deleted, version FROM messages ORDER BY ts`,
  );
}

/** The row `readMessages` reads for `posted` as it was posted. `changes` replace its columns. */
function stored(posted: RawMessage, changes: object = {}) {
  return {
    channel_id: posted.channel,
    ts: posted.ts,
    text: posted.text,
    deleted: 0,
    version: posted.ts,
    ...changes,
  };
}

function readRemovals(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT ts, deleted, withdrawn FROM messages ORDER BY ts`);
}

function readRequests(database: BridgeDatabase) {
  return database.read(
    (sql) => sql`SELECT id, state, closed_reason, source_unverified_at FROM requests ORDER BY id`,
  );
}

function readUpdates(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT ts, updated_seq FROM messages ORDER BY ts`);
}

function readReceipts(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT key, type, disposition FROM receipts ORDER BY key`);
}

function readGaps(database: BridgeDatabase) {
  return database.read(
    (sql) =>
      sql`SELECT link_id, channel_id, oldest_ts, latest_ts, reason FROM coverage ORDER BY id`,
  );
}

function readChannels(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT slack_channel_id FROM links`);
}

function readLinks(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT id, status, status_reason FROM links ORDER BY id`);
}

const activeLink = { id: "link", status: "active", status_reason: null };

function silenceLog() {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

describe("committing before the ack", () => {
  test("a delivery is acked only once everything it changed has committed", async () => {
    const { path, receiver } = await openReceiver();
    const reader = new Database(path, { readonly: true });
    onTestFinished(() => reader.close());
    const seen: unknown[] = [];

    const ask = message("1700000100.000100", "<@U0BOT> can you deploy?");
    await receiver.receive(eventFrame("1", ask), arrivedAt, (envelopeId) => {
      seen.push(envelopeId, reader.query("SELECT ts FROM messages").all());
      seen.push(reader.query("SELECT key, type, received_at, disposition FROM receipts").all());
      seen.push(reader.query("SELECT source_ts FROM requests").all());
    });

    expect(seen).toEqual([
      "env-1",
      [{ ts: ask.ts }],
      [{ key: "Ev-1", type: "message", received_at: arrivedAt, disposition: "applied" }],
      [{ source_ts: ask.ts }],
    ]);
  });

  test("a delivery that fails to commit isn't acked, and nothing after it is handled", async () => {
    const log = silenceLog();
    const errors: unknown[] = [];
    const { database, receive, acks } = await openReceiver({ onError: (e) => errors.push(e) });
    await database.write(
      (transaction) => transaction`
        CREATE TRIGGER fail_first BEFORE INSERT ON receipts WHEN NEW.key = 'Ev-1'
        BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
      `,
    );

    await Promise.all([
      receive(eventFrame("1", message("1700000100.000100", "first"))),
      receive(eventFrame("2", message("1700000200.000100", "queued"))),
    ]);
    await database.write((transaction) => transaction`DROP TRIGGER fail_first`);
    await receive(eventFrame("3", message("1700000300.000100", "after")));

    expect(acks).toEqual([]);
    expect(await readMessages(database)).toEqual([]);
    expect(await readReceipts(database)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Stopped receiving from Slack:", errors[0]);
  });

  test("a delivery stored too late isn't acked, and its redelivery is acked and changes nothing", async () => {
    const log = silenceLog();
    const { database, receive, acks, changes } = await openReceiver();
    const ask = eventFrame("1", message("1700000100.000100", "<@U0BOT> can you deploy?"));

    await receive(ask, committedAt - ACK_DEADLINE_MS - 1);
    expect(acks).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "Stored a delivery from Slack too late to ack it, so Slack will resend it.",
    );
    const before = await readUpdates(database);
    expect(before).toHaveLength(1);
    expect(changes()).toBe(1);

    await receive({ ...ask, envelopeId: "env-1-again" }, committedAt - ACK_DEADLINE_MS);
    expect(acks).toEqual(["env-1-again"]);
    expect(await readUpdates(database)).toEqual(before);
    expect(await database.read((sql) => sql`SELECT id FROM requests`)).toHaveLength(1);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
    ]);
    expect(changes()).toBe(1);
  });

  test("deliveries are handled one at a time in the order they arrived", async () => {
    const { database, receive, acks } = await openReceiver();
    const posted = message("1700000100.000100", "soon gone");

    await Promise.all([
      receive(eventFrame("1", posted)),
      receive(eventFrame("2", deleted(posted.ts))),
      receive(eventFrame("3", changed({ ...posted, text: "too late" }))),
    ]);

    expect(acks).toEqual(["env-1", "env-2", "env-3"]);
    expect(await readMessages(database)).toEqual([stored(posted, { text: null, deleted: 1 })]);
  });

  test("stopping finishes the delivery in hand and handles nothing after it", async () => {
    let ackedWhenStopped: Promise<string[]> | undefined;
    const opened = await openReceiver({
      // The bridge stops as the first delivery, now in hand, reads the clock to commit.
      now: () => {
        ackedWhenStopped ??= opened.receiver.stop().then(() => [...opened.acks]);
        return committedAt;
      },
    });
    const { database, receive, acks } = opened;
    const first = message("1700000100.000100", "first");

    await Promise.all([
      receive(eventFrame("1", first)),
      receive(eventFrame("2", message("1700000200.000100", "queued"))),
    ]);
    await receive(eventFrame("3", message("1700000300.000100", "after")));

    expect(await ackedWhenStopped).toEqual(["env-1"]);
    expect(acks).toEqual(["env-1"]);
    expect(await readMessages(database)).toEqual([stored(first)]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
    ]);
  });
});

describe("what's taken", () => {
  test("nothing is taken before the bridge knows who it is, or once it's uninstalled", async () => {
    for (const installation of [null, { status: "uninstalled" as const }]) {
      const { database, receive, acks } = await openReceiver({ installation });
      await receive(eventFrame("1", message("1700000100.000100", "<@U0BOT> hello?")));
      expect(acks).toEqual(["env-1"]);
      expect(await readMessages(database)).toEqual([]);
      expect(await readReceipts(database)).toEqual([]);
    }
  });

  test("a delivery for another app, workspace or bot is acked as foreign and changes nothing", async () => {
    const { database, receive, acks, changes } = await openReceiver();
    const ask = message("1700000100.000100", "<@U0BOT> hello?");
    await receive(eventFrame("1", ask, { api_app_id: "A-other" }));
    await receive(eventFrame("2", ask, { authorizations: [{ ...ourBot, user_id: "U0OTHER" }] }));
    await receive(eventFrame("3", { type: "app_uninstalled" }, { team_id: "T-other" }));
    for (const [team, app] of [
      ["T-other", "A-app"],
      ["T-home", "A-other"],
    ]) {
      const minute = { minute_rate_limited: 1_700_000_940 };
      await receive(
        delivery({ type: "app_rate_limited", team_id: team, api_app_id: app, ...minute }),
      );
    }

    expect(acks).toEqual(["env-1", "env-2", "env-3"]);
    expect(await readMessages(database)).toEqual([]);
    expect(await readGaps(database)).toEqual([]);
    expect(await readLinks(database)).toEqual([activeLink]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "foreign" },
      { key: "Ev-2", type: "message", disposition: "foreign" },
      { key: "Ev-3", type: "app_uninstalled", disposition: "foreign" },
      {
        key: "app_rate_limited:A-app:T-other:1700000940",
        type: "app_rate_limited",
        disposition: "foreign",
      },
      {
        key: "app_rate_limited:A-other:T-home:1700000940",
        type: "app_rate_limited",
        disposition: "foreign",
      },
    ]);
    expect(changes()).toBe(0);
  });

  test("a message is stored and opens a request, and what no link uses is only acked", async () => {
    const { database, receive, acks, changes } = await openReceiver();
    const ask = message("1700000100.000100", "<@U0BOT> can you deploy?");
    const unrelated = message("1700000200.000100", "unrelated");
    await receive(eventFrame("1", ask));
    await receive(eventFrame("2", unrelated));
    await receive(eventFrame("3", { ...ask, channel: "C-elsewhere" }));
    await receive(eventFrame("4", { type: "reaction_added", user: "U-alice" }));
    await receive(delivery({ type: "slash_commands", envelope_id: "env-5", payload: {} }));

    expect(acks).toEqual(["env-1", "env-2", "env-3", "env-4", "env-5"]);
    expect(await readMessages(database)).toEqual([stored(ask), stored(unrelated)]);
    expect(
      await database.read((sql) => sql`SELECT source_ts, late, created_at FROM requests`),
    ).toEqual([{ source_ts: ask.ts, late: 0, created_at: committedAt }]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
      { key: "Ev-2", type: "message", disposition: "applied" },
      { key: "Ev-3", type: "message", disposition: "unlinked" },
      { key: "Ev-4", type: "reaction_added", disposition: "ignored" },
      { key: "env-5", type: "slash_commands", disposition: "ignored" },
    ]);
    expect(changes()).toBe(1);
  });

  test("our bot's messages and other bots' are told apart from people's", async () => {
    const { database, receive } = await openReceiver();
    await database.write((transaction) =>
      writeSlackPerson(transaction, slackPerson({ id: "U-helper", isBot: true }), 1),
    );
    const ours = message("1700000100.000100", "deployed", {
      subtype: "bot_message",
      bot_id: "B-bot",
      user: undefined,
    });
    const helper = message("1700000200.000100", "<@U0BOT> beep", { user: "U-helper" });
    await receive(eventFrame("1", ours));
    await receive(eventFrame("2", helper));

    expect(
      await database.read((sql) => sql`SELECT ts, author_role, text FROM messages ORDER BY ts`),
    ).toEqual([
      { ts: ours.ts, author_role: "self", text: "deployed" },
      { ts: helper.ts, author_role: "other", text: null },
    ]);
    expect(await database.read((sql) => sql`SELECT id FROM requests`)).toEqual([]);
  });

  test("a deleted file or message loses its local copies once the delete commits", async () => {
    const { database, filesFolder, receive, acks } = await openReceiver();
    const shared = message("1700000100.000100", "screenshots", { files: [file("F1"), file("F2")] });
    await receive(eventFrame("1", shared));
    await fetchFiles(database, filesFolder);
    const readFiles = () => database.read((sql) => sql`SELECT file_id FROM files`);

    await receive(eventFrame("2", { type: "file_deleted", file_id: "F1" }));
    await receive(eventFrame("3", { type: "file_deleted", file_id: "F9" }));
    expect(await readFiles()).toEqual([{ file_id: "F2" }]);
    expect(existsSync(join(filesFolder, "F1.png"))).toBe(false);
    expect(existsSync(join(filesFolder, "F2.png"))).toBe(true);

    await receive(eventFrame("4", deleted(shared.ts)));
    expect(await readFiles()).toEqual([]);
    expect(existsSync(join(filesFolder, "F2.png"))).toBe(false);

    expect(acks).toEqual(["env-1", "env-2", "env-3", "env-4"]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
      { key: "Ev-2", type: "file_deleted", disposition: "applied" },
      { key: "Ev-3", type: "file_deleted", disposition: "ignored" },
      { key: "Ev-4", type: "message", disposition: "applied" },
    ]);
  });

  test("content Slack withdraws loses its text and local copies, and holds its request's replies", async () => {
    const { database, filesFolder, receive, acks, changes } = await openReceiver();
    const ask = message("1700000100.000100", "<@U0BOT> what broke?", { files: [file("F1")] });
    await receive(eventFrame("1", ask));
    await fetchFiles(database, filesFolder);

    const redacted = revokedOf(ask);
    await receive(eventFrame("2", changed(redacted)));
    await receive(eventFrame("3", redacted));
    await receive(eventFrame("4", { ...ask, text: "<@U0BOT> what broke?", files: [] }));

    expect(acks).toEqual(["env-1", "env-2", "env-3", "env-4"]);
    expect(await readMessages(database)).toEqual([stored(ask, { text: null, deleted: 1 })]);
    expect(await readRemovals(database)).toEqual([{ ts: ask.ts, deleted: 1, withdrawn: 1 }]);
    expect(await database.read((sql) => sql`SELECT file_id FROM files`)).toEqual([]);
    expect(existsSync(join(filesFolder, "F1.png"))).toBe(false);
    expect(await readRequests(database)).toEqual([
      { id: 1, state: "open", closed_reason: null, source_unverified_at: committedAt },
    ]);
    expect(changes()).toBe(2);
  });

  test("while Slack rejects the bot token, only what repair can't find later is taken", async () => {
    silenceLog();
    const { database, receive, acks } = await openReceiver();
    const posted = message("1700000100.000100", "before the failure");
    const kept = message("1700000150.000100", "also before the failure");
    await receive(eventFrame("1", posted));
    await receive(eventFrame("2", kept));
    await database.write(
      (transaction) => transaction`
        UPDATE installation SET status = 'auth_failed', auth_failed_at = ${arrivedAt}
      `,
    );

    await receive(eventFrame("3", message("1700000200.000100", "during the failure")));
    await receive(eventFrame("4", changed({ ...posted, text: "edited during the failure" })));
    await receive(eventFrame("5", deleted(posted.ts)));
    await receive(eventFrame("6", changed(revokedOf(kept))));
    await receive(
      eventFrame("7", { type: "member_left_channel", user: "U0BOT", channel: "C-link" }),
    );
    await receive(eventFrame("8", { type: "message", channel: "C-link", ts: "soon" }));

    expect(acks).toEqual(["env-1", "env-2", "env-3", "env-4", "env-5", "env-6", "env-7", "env-8"]);
    expect(await readMessages(database)).toEqual([
      stored(posted, { text: null, deleted: 1 }),
      stored(kept, { text: null, deleted: 1 }),
    ]);
    expect(await readRemovals(database)).toEqual([
      { ts: posted.ts, deleted: 1, withdrawn: 0 },
      { ts: kept.ts, deleted: 1, withdrawn: 1 },
    ]);
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "bot_removed" },
    ]);
    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "malformed" },
    ]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
      { key: "Ev-2", type: "message", disposition: "applied" },
      { key: "Ev-3", type: "message", disposition: "ignored" },
      { key: "Ev-4", type: "message", disposition: "ignored" },
      { key: "Ev-5", type: "message", disposition: "applied" },
      { key: "Ev-6", type: "message", disposition: "applied" },
      { key: "Ev-7", type: "member_left_channel", disposition: "applied" },
      { key: "Ev-8", type: "message", disposition: "malformed" },
    ]);
  });
});

describe("gaps", () => {
  /** Adds a suspended link on C-other, and one on C-late that began after the gaps here. */
  async function linkMore(database: BridgeDatabase) {
    await createStoredLink(database, "other", {
      status: "suspended",
      status_reason: "paused",
    });
    await createStoredLink(database, "late");
    await database.write(
      (transaction) => transaction`
        UPDATE links SET linked_at_ts = '1700002000.000100' WHERE id = 'late'
      `,
    );
  }

  test("a rate limit leaves a gap for its minute in every linked channel, once", async () => {
    const log = silenceLog();
    const { database, receive, acks } = await openReceiver();
    await linkMore(database);
    const limited = {
      type: "app_rate_limited",
      team_id: "T-home",
      api_app_id: "A-app",
      minute_rate_limited: 1_700_000_940,
    };

    await receive(delivery({ type: "events_api", envelope_id: "env-1", payload: limited }));
    await receive(delivery(limited));

    const window = { oldest_ts: "1700000640.000000", latest_ts: "1700001300.000000" };
    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-link", ...window, reason: "rate_limited" },
      { link_id: "other", channel_id: "C-other", ...window, reason: "rate_limited" },
    ]);
    expect(acks).toEqual(["env-1"]);
    expect(await readReceipts(database)).toEqual([
      {
        key: "app_rate_limited:A-app:T-home:1700000940",
        type: "app_rate_limited",
        disposition: "rate_limited",
      },
    ]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("an event that can't be read is acked and logged without content, with a gap from when it happened", async () => {
    const log = silenceLog();
    const { database, receive, acks } = await openReceiver();
    await linkMore(database);
    const secret = "the launch code is 4829-1734";

    await receive(eventFrame("1", message("not a ts", secret)));
    await receive(eventFrame("2", { type: "member_left_channel", user: secret }));

    expect(acks).toEqual(["env-1", "env-2"]);
    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "malformed" },
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "malformed" },
      { link_id: "other", channel_id: "C-other", ...eventGap, reason: "malformed" },
    ]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "malformed" },
      { key: "Ev-2", type: "member_left_channel", disposition: "malformed" },
    ]);
    expect(log).toHaveBeenCalledWith(
      "Couldn't read an event of type message from Slack, so repair will read around it: invalid_union at event",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("4829");
  });

  test("a frame that can't be read leaves a gap where its hint points, or everywhere", async () => {
    const log = silenceLog();
    const { database, receive, acks } = await openReceiver();
    await linkMore(database);

    // Its event ID isn't a string, so it can't be read, but its time and channel can.
    const unreadable = {
      type: "event_callback",
      event_id: 7,
      event_time: 1_700_000_900,
      event: { type: "message", channel: "C-link" },
    };
    await receive(delivery({ type: "events_api", envelope_id: "env-1", payload: unreadable }));
    await receive(delivery("{not json"));

    expect(acks).toEqual(["env-1"]);
    const sinceArrival = { oldest_ts: "1700000700.000000", latest_ts: "1700001300.000000" };
    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "malformed" },
      { link_id: "link", channel_id: "C-link", ...sinceArrival, reason: "malformed" },
      { link_id: "other", channel_id: "C-other", ...sinceArrival, reason: "malformed" },
    ]);
    expect(await readReceipts(database)).toEqual([
      { key: "env-1", type: "unknown", disposition: "malformed" },
    ]);
    expect(log).toHaveBeenCalledWith(
      "Couldn't read a frame from Slack, so repair will read around it: invalid_json",
    );
  });

  test("an event Slack timed after it arrived leaves a gap from its arrival", async () => {
    silenceLog();
    const { database, receive } = await openReceiver();
    await receive(eventFrame("1", message("not a ts", "garbled"), { event_time: 1_700_009_000 }));

    expect(await readGaps(database)).toEqual([
      {
        link_id: "link",
        channel_id: "C-link",
        oldest_ts: "1700000700.000000",
        latest_ts: "1700001300.000000",
        reason: "malformed",
      },
    ]);
  });
});

describe("the connection", () => {
  function readMarkers(database: BridgeDatabase) {
    return database.read(async (sql) => {
      const [row] = await sql`SELECT connected_at, disconnected_at FROM installation`;
      return row;
    });
  }

  test("each hello records a gap up to it in turn, the first one for startup", async () => {
    const { database, receiver, receive } = await openReceiver();
    const linked = { link_id: "link", channel_id: "C-link" };
    await receiver.connected(arrivedAt - 60_000);
    // From when the link began, since nothing was received before.
    const startup = { oldest_ts: "1700000000.000100", latest_ts: "1700001240.000000" };
    expect(await readGaps(database)).toEqual([{ ...linked, ...startup, reason: "startup" }]);

    // The connection is lost right behind a delivery, and Slack says hello again right ahead of one.
    const lostAt = arrivedAt + 10_000;
    const helloAt = arrivedAt + 20_000;
    await Promise.all([
      receive(eventFrame("1", message("1700000100.000100", "<@U0BOT> can you deploy?"))),
      receiver.disconnected(lostAt),
      receiver.connected(helloAt),
      receive(eventFrame("2", message("1700001019.000100", "after")), helloAt + 1_000),
    ]);

    expect(await readRequests(database)).toEqual([
      { id: 1, state: "open", closed_reason: null, source_unverified_at: lostAt },
    ]);
    // From the last delivery before the connection was lost.
    const lost = { oldest_ts: "1700000700.000000", latest_ts: "1700001320.000000" };
    expect(await readGaps(database)).toEqual([
      { ...linked, ...startup, reason: "startup" },
      { ...linked, ...lost, reason: "disconnect" },
    ]);
    expect(await readMarkers(database)).toEqual({ connected_at: helloAt, disconnected_at: lostAt });
  });

  test("a hello that fails to commit stops the receiver", async () => {
    const log = silenceLog();
    const errors: unknown[] = [];
    const { database, receiver, receive } = await openReceiver({
      onError: (error) => errors.push(error),
    });
    await database.write(
      (transaction) => transaction`
        CREATE TRIGGER fail_gap BEFORE INSERT ON coverage
        BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
      `,
    );

    await receiver.connected(arrivedAt);
    await receive(eventFrame("1", message("1700000100.000100", "after")));

    expect(await readMarkers(database)).toEqual({ connected_at: null, disconnected_at: null });
    expect(await readMessages(database)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Stopped receiving from Slack:", errors[0]);
  });

  test("a lost connection that fails to commit stops the receiver", async () => {
    const log = silenceLog();
    const errors: unknown[] = [];
    const { database, receiver, receive } = await openReceiver({
      onError: (error) => errors.push(error),
    });
    await database.write(
      (transaction) => transaction`
        CREATE TRIGGER fail_marker BEFORE UPDATE ON installation
        BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
      `,
    );

    await receiver.disconnected(arrivedAt);
    await receive(eventFrame("1", message("1700000100.000100", "after")));

    expect(await readMessages(database)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Stopped receiving from Slack:", errors[0]);
  });

  test("a stopped receiver records neither a hello nor a lost connection", async () => {
    const { database, receiver } = await openReceiver();
    await receiver.stop();

    await receiver.connected(arrivedAt);
    await receiver.disconnected(arrivedAt);
    expect(await readGaps(database)).toEqual([]);
    expect(await readMarkers(database)).toEqual({ connected_at: null, disconnected_at: null });
  });
});

describe("a channel's lifecycle", () => {
  test("a notice about the channel is stored and suspends the links it makes unsafe", async () => {
    const { database, receive, changes } = await openReceiver();
    const notice = message("1700000100.000100", "made this channel public", {
      subtype: "channel_convert_to_public",
    });

    await receive(eventFrame("1", notice));

    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "channel_made_public" },
    ]);
    expect(await readMessages(database)).toEqual([stored(notice, { text: null })]);
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
    ]);
    expect(changes()).toBe(1);
  });

  test("a renamed channel's stored facts wait for a fresh read", async () => {
    const { database, receive, changes } = await openReceiver();
    await database.write((transaction) => writeChannelInfo(transaction, channelFacts(), 1));

    await receive(
      eventFrame("1", { type: "channel_rename", channel: { id: "C-link", name: "x" } }),
    );

    expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
      facts: channelFacts(),
      refreshedAt: 1,
      invalidatedAt: committedAt,
    });
    expect(await readLinks(database)).toEqual([activeLink]);
    expect(changes()).toBe(1);
  });

  test("a channel Slack gives a new ID keeps what's stored for it, with a gap for the move", async () => {
    const { database, receive, changes } = await openReceiver();
    const ask = message("1700000100.000100", "<@U0BOT> can you deploy?");
    await receive(eventFrame("1", ask));

    await receive(eventFrame("2", moved("C-link", "C-new")));

    expect(await readChannels(database)).toEqual([{ slack_channel_id: "C-new" }]);
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "channel_id_changed" },
    ]);
    expect(await readMessages(database)).toEqual([stored(ask, { channel_id: "C-new" })]);
    expect(
      await database.read((sql) => sql`SELECT channel_id, source_unverified_at FROM requests`),
    ).toEqual([{ channel_id: "C-new", source_unverified_at: committedAt }]);
    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-new", ...eventGap, reason: "moved" },
    ]);
    expect(changes()).toBe(2);

    // Once the owner resumes it, a late event under the old ID still reaches it.
    await database.write(
      (transaction) => transaction`UPDATE links SET status = 'active', status_reason = NULL`,
    );
    const late = message("1700000300.000100", "still here");
    await receive(eventFrame("3", late));
    await receive(eventFrame("4", { type: "channel_archive", channel: "C-link", user: "U-alice" }));

    expect(await readMessages(database)).toEqual([
      stored(ask, { channel_id: "C-new" }),
      stored(late, { channel_id: "C-new" }),
    ]);
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "channel_archived" },
    ]);
  });

  test("a channel Slack moves back to an ID it had before follows it back", async () => {
    const { database, receive } = await openReceiver();
    const ask = message("1700000100.000100", "<@U0BOT> can you deploy?");
    await receive(eventFrame("1", ask));
    await receive(eventFrame("2", moved("C-link", "C-new")));
    await receive(eventFrame("3", moved("C-new", "C-link")));
    const late = message("1700000300.000100", "sent before the move back", { channel: "C-new" });
    await database.write(
      (transaction) => transaction`UPDATE links SET status = 'active', status_reason = NULL`,
    );
    await receive(eventFrame("4", late));

    expect(await readChannels(database)).toEqual([{ slack_channel_id: "C-link" }]);
    expect(await readMessages(database)).toEqual([
      stored(ask),
      stored(late, { channel_id: "C-link" }),
    ]);
    expect(await database.read((sql) => sql`SELECT channel_id FROM requests`)).toEqual([
      { channel_id: "C-link" },
    ]);
    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "moved" },
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "moved" },
    ]);
  });

  test("an event naming an ID Slack moved the channel from acts on it at its current ID", async () => {
    silenceLog();
    const { database, receive } = await openReceiver();
    await database.write(async (transaction) => {
      await recordChannelAlias(transaction, "C-old", "C-link", 1);
      await writeChannelInfo(transaction, channelFacts(), 1);
    });

    await receive(eventFrame("1", { type: "channel_rename", channel: { id: "C-old", name: "x" } }));
    expect(await database.read((sql) => readChannelInfo(sql, "C-link"))).toEqual({
      facts: channelFacts(),
      refreshedAt: 1,
      invalidatedAt: committedAt,
    });

    await receive(eventFrame("2", { type: "message", channel: "C-old", ts: "garbled" }));
    await receive(eventFrame("3", { type: "channel_archive", channel: "C-old", user: "U-alice" }));

    expect(await readGaps(database)).toEqual([
      { link_id: "link", channel_id: "C-link", ...eventGap, reason: "malformed" },
    ]);
    expect(await readLinks(database)).toEqual([
      { id: "link", status: "suspended", status_reason: "channel_archived" },
    ]);
  });

  test("an uninstall deletes everything, removes local copies, and leaves nothing to take", async () => {
    const uninstalled: number[] = [];
    const { database, filesFolder, receive, acks, changes } = await openReceiver({
      onUninstalled: () => uninstalled.push(changes()),
    });
    await receive(eventFrame("1", message("1700000100.000100", "files", { files: [file("F1")] })));
    await fetchFiles(database, filesFolder);

    await receive(eventFrame("2", { type: "tokens_revoked", tokens: { bot: ["U0OTHER"] } }));
    expect(await readReceipts(database)).toEqual([
      { key: "Ev-1", type: "message", disposition: "applied" },
      { key: "Ev-2", type: "tokens_revoked", disposition: "ignored" },
    ]);

    await receive(eventFrame("3", { type: "app_uninstalled" }));
    await receive(eventFrame("4", message("1700000200.000100", "<@U0BOT> anyone?")));

    expect(acks).toEqual(["env-1", "env-2", "env-3", "env-4"]);
    expect(await database.read((sql) => sql`SELECT status FROM installation`)).toEqual([
      { status: "uninstalled" },
    ]);
    expect(await readLinks(database)).toEqual([]);
    expect(await readMessages(database)).toEqual([]);
    expect(await readReceipts(database)).toEqual([]);
    expect(existsSync(join(filesFolder, "F1.png"))).toBe(false);
    expect(uninstalled).toEqual([1]);
  });
});

describe("Slack's own sequences", () => {
  test("deleting a thread's last reply changes nothing about its root", async () => {
    const { database, receive } = await openReceiver();
    const root = message("1700000100.000100", "the root");
    const reply = message("1700000200.000100", "the reply", { thread_ts: root.ts });
    const edited = { ...root, text: "the root, edited", edited: { ts: "1700000150.000100" } };
    await receive(eventFrame("1", root));
    await receive(eventFrame("2", reply));
    await receive(eventFrame("3", changed({ ...edited, thread_ts: root.ts })));
    const before = await readUpdates(database);

    // Slack names no thread on the delete, then sends the root as it was, minus its replies.
    await receive(eventFrame("4", deleted(reply.ts, { ...reply, user: "U-alice" })));
    await receive(eventFrame("5", changed(edited)));

    expect(await readMessages(database)).toEqual([
      stored(edited, { version: "1700000150.000100" }),
      stored(reply, { text: null, deleted: 1 }),
    ]);
    const after = await readUpdates(database);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]?.updated_seq).toBeGreaterThan(before[1]?.updated_seq);
  });

  test("deleting a root with replies cancels its request by the tombstone Slack leaves, and keeps the replies", async () => {
    const { database, receive, changes } = await openReceiver();
    const root = message("1700000100.000100", "<@U0BOT> can you deploy?");
    const reply = message("1700000200.000100", "me too", { thread_ts: root.ts });
    await receive(eventFrame("1", root));
    await receive(eventFrame("2", reply));

    // Slack sends only the tombstone it leaves where the root was.
    await receive(eventFrame("3", changed(tombstoneOf(root, 1))));
    expect(await readMessages(database)).toEqual([
      stored(root, { text: null, deleted: 1 }),
      stored(reply),
    ]);
    expect(await readRemovals(database)).toEqual([
      { ts: root.ts, deleted: 1, withdrawn: 0 },
      { ts: reply.ts, deleted: 0, withdrawn: 0 },
    ]);
    expect(await readRequests(database)).toEqual([
      { id: 1, state: "cancelled", closed_reason: "source_deleted", source_unverified_at: null },
    ]);

    // The root's own delete follows its last reply's, and changes nothing more.
    await receive(eventFrame("4", deleted(reply.ts, reply)));
    const before = { changes: changes(), updates: await readUpdates(database) };
    await receive(eventFrame("5", deleted(root.ts, root)));
    expect({ changes: changes(), updates: await readUpdates(database) }).toEqual(before);
    expect(await readReceipts(database)).toEqual(
      ["1", "2", "3", "4", "5"].map((n) => ({
        key: `Ev-${n}`,
        type: "message",
        disposition: "applied",
      })),
    );
  });

  test("editing a root that has a broadcast reply changes only the root", async () => {
    const { database, receive } = await openReceiver();
    const root = message("1700000100.000100", "the root");
    const broadcast = message("1700000200.000100", "also in the channel", {
      subtype: "thread_broadcast",
      thread_ts: root.ts,
      root: { ...root, thread_ts: root.ts, reply_count: 1 },
    });
    await receive(eventFrame("1", root));
    await receive(eventFrame("2", broadcast));
    const before = await readUpdates(database);

    // Slack first sends the broadcast with only its copy of the root changed, and no edit of its own.
    const edited = { ...root, text: "the root, edited", edited: { ts: "1700000300.000100" } };
    await receive(eventFrame("3", changed({ ...broadcast, root: edited })));
    expect(await readUpdates(database)).toEqual(before);

    await receive(eventFrame("4", changed(edited)));
    expect(await readMessages(database)).toEqual([
      stored(edited, { version: "1700000300.000100" }),
      stored(broadcast),
    ]);
  });
});

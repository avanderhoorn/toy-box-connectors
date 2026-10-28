import { describe, expect, test } from "bun:test";
import {
  normalizeHistoryMessage,
  normalizeMessageEvent,
  slackMessageEventSchema,
  type NormalizeContext,
  type SlackMessageEvent,
} from "./messages";

const context: NormalizeContext = {
  botUserId: "UBOT",
  botId: "BBOT",
  isBotUser: (userId) => userId === "UHELPER",
};

/** Parses and normalizes a raw message event the way the receiver does. */
function normalize(event: Record<string, unknown>): SlackMessageEvent {
  return normalizeMessageEvent(slackMessageEventSchema.parse(event), context);
}

function message(event: Record<string, unknown>) {
  const normalized = normalize({ type: "message", channel: "C1", ...event });
  if (normalized.kind !== "message") throw new Error(`expected a message, got ${normalized.kind}`);
  return normalized.message;
}

const plain = { user: "UALICE", team: "THOME", text: "hello", ts: "1700000000.000100" };

describe("normalizing Slack messages", () => {
  test("a plain message is a person's root message", () => {
    expect(normalize({ type: "message", channel: "C1", ...plain })).toEqual({
      kind: "message",
      edit: false,
      message: {
        channelId: "C1",
        ts: "1700000000.000100",
        threadTs: null,
        rootTs: "1700000000.000100",
        isReply: false,
        userId: "UALICE",
        teamId: "THOME",
        subtype: null,
        author: "person",
        text: "hello",
        files: [],
        mentions: [],
        mentionsBot: false,
        editedTs: null,
        version: "1700000000.000100",
        latestReplyTs: null,
      },
    });
  });

  test("a root that carries its own ts as thread_ts is still a root", () => {
    const root = message({ ...plain, thread_ts: plain.ts, latest_reply: "1700000009.000100" });
    expect(root).toMatchObject({
      threadTs: plain.ts,
      rootTs: plain.ts,
      isReply: false,
      latestReplyTs: "1700000009.000100",
    });
  });

  test("a reply belongs to its root's thread", () => {
    const reply = message({ ...plain, ts: "1700000005.000200", thread_ts: plain.ts });
    expect(reply).toMatchObject({ rootTs: plain.ts, threadTs: plain.ts, isReply: true });
  });

  test("the author's home team comes before the message's team", () => {
    expect(message({ ...plain, team: "THOME", user_team: "TGUEST" }).teamId).toBe("TGUEST");
    expect(message({ ...plain, team: "TGUEST" }).teamId).toBe("TGUEST");
  });

  test("a message that leaves out its team has none, rather than the installation's", () => {
    expect(message({ ...plain, team: undefined }).teamId).toBeNull();
    expect(message({ ...plain, team: null, user_team: null }).teamId).toBeNull();
  });

  test("an edit carries the whole message as it is now, versioned by the edit", () => {
    // Slack hides the edit event itself from people, never the message it carries.
    const edited = normalize({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      hidden: true,
      ts: "1700000050.000300",
      message: {
        ...plain,
        text: "hello again",
        edited: { user: "UALICE", ts: "1700000049.000000" },
      },
      previous_message: plain,
    });
    expect(edited).toMatchObject({
      kind: "message",
      edit: true,
      message: {
        channelId: "C1",
        ts: plain.ts,
        text: "hello again",
        subtype: null,
        editedTs: "1700000049.000000",
        version: "1700000049.000000",
      },
    });
  });

  test("an edit Slack made without an edited stamp keeps the message's own version", () => {
    const unfurled = normalize({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: { ...plain, attachments: [{ title: "A link preview" }] },
    });
    expect(unfurled).toMatchObject({
      kind: "message",
      edit: true,
      message: { editedTs: null, version: plain.ts },
    });
  });

  test("a delete names the deleted message, not the event", () => {
    const deleted = normalize({
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      hidden: true,
      ts: "1700000060.000000",
      deleted_ts: plain.ts,
      previous_message: plain,
    });
    expect(deleted).toEqual({ kind: "deleted", channelId: "C1", ts: plain.ts });
  });

  test("the tombstone Slack leaves of a root deleted with replies deletes it, live or from history", () => {
    // It's hidden and Slackbot's, yet it's neither a withdrawal nor a bot's message.
    const tombstone = {
      subtype: "tombstone",
      user: "USLACKBOT",
      hidden: true,
      text: "This message was deleted.",
      ts: plain.ts,
      thread_ts: plain.ts,
      reply_count: 1,
      latest_reply: "1700000070.000000",
    };
    const deleted: SlackMessageEvent = { kind: "deleted", channelId: "C1", ts: plain.ts };
    expect(
      normalize({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        hidden: true,
        message: tombstone,
      }),
    ).toEqual(deleted);
    expect(normalizeHistoryMessage("C1", tombstone, context)).toEqual(deleted);
  });

  test("content an admin's key no longer unlocks is withdrawn, at its own ts, live or from history", () => {
    const redacted = {
      subtype: "ekm_access_denied",
      user: "UALICE",
      text: "Your admins have suspended everyone's access to this content.",
      ts: plain.ts,
    };
    const withdrawn: SlackMessageEvent = { kind: "withdrawn", channelId: "C1", ts: plain.ts };
    expect(normalize({ type: "message", channel: "C1", ...redacted })).toEqual(withdrawn);
    expect(
      normalize({ type: "message", subtype: "message_changed", channel: "C1", message: redacted }),
    ).toEqual(withdrawn);
    expect(normalizeHistoryMessage("C1", redacted, context)).toEqual(withdrawn);
  });

  test("a message Slack credits to its revoked user is withdrawn, whatever its subtype", () => {
    expect(normalize({ type: "message", channel: "C1", ...plain, user: "UREVOKEDU" })).toEqual({
      kind: "withdrawn",
      channelId: "C1",
      ts: plain.ts,
    });
  });

  test("a message Slack hides from people is withdrawn", () => {
    expect(normalize({ type: "message", channel: "C1", ...plain, hidden: true })).toEqual({
      kind: "withdrawn",
      channelId: "C1",
      ts: plain.ts,
    });
    expect(normalize({ type: "message", channel: "C1", ...plain, hidden: false }).kind).toBe(
      "message",
    );
  });

  test("a reply notice updates the thread's bookkeeping and never repeats its root", () => {
    const replied = normalize({
      type: "message",
      subtype: "message_replied",
      channel: "C1",
      hidden: true,
      message: { ...plain, thread_ts: plain.ts, reply_count: 2, latest_reply: "1700000070.000000" },
    });
    expect(replied).toEqual({
      kind: "replied",
      channelId: "C1",
      threadTs: plain.ts,
      latestReplyTs: "1700000070.000000",
    });
  });

  test("a thread broadcast is a person's reply, identified by its own ts", () => {
    const broadcast = message({
      ...plain,
      subtype: "thread_broadcast",
      ts: "1700000080.000000",
      thread_ts: plain.ts,
      root: plain,
    });
    expect(broadcast).toMatchObject({
      ts: "1700000080.000000",
      rootTs: plain.ts,
      isReply: true,
      subtype: "thread_broadcast",
      author: "person",
    });
  });

  test("file shares and /me messages are a person's, and keep their files", () => {
    const shared = message({
      ...plain,
      subtype: "file_share",
      text: undefined,
      files: [
        { id: "F1", name: "notes.txt", mimetype: "text/plain", size: 12, url_private: "https://x" },
        { id: "F2", mode: "hidden_by_limit" },
      ],
    });
    expect(shared).toMatchObject({ author: "person", text: "" });
    expect(shared.files).toEqual([
      { id: "F1", name: "notes.txt", mimetype: "text/plain", size: 12 },
      { id: "F2", name: null, mimetype: null, size: null },
    ]);
    expect(message({ ...plain, subtype: "me_message" }).author).toBe("person");
  });

  test("a deleted file drops out of its message, so a later edit never indexes it again", () => {
    const edited = normalize({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: {
        ...plain,
        edited: { ts: "1700000001.000100" },
        files: [
          { id: "F1", mode: "hosted", name: "notes.txt" },
          { id: "F2", mode: "tombstone" },
        ],
      },
    });
    expect(edited.kind === "message" && edited.message.files).toEqual([
      { id: "F1", name: "notes.txt", mimetype: null, size: null },
    ]);
  });

  test("our bot's own messages are self", () => {
    expect(message({ ...plain, user: "UBOT", bot_id: "BBOT" }).author).toBe("self");
    expect(message({ subtype: "bot_message", bot_id: "BBOT", ts: plain.ts }).author).toBe("self");
    expect(message({ ...plain, user: "UBOT", subtype: "thread_broadcast" }).author).toBe("self");
  });

  test("other bots, apps and Slackbot are bots", () => {
    expect(message({ ...plain, bot_id: "BOTHER" }).author).toBe("bot");
    expect(message({ ...plain, app_id: "AOTHER" }).author).toBe("bot");
    expect(message({ subtype: "bot_message", username: "ci", ts: plain.ts }).author).toBe("bot");
    expect(message({ ...plain, subtype: "file_share", bot_id: "BOTHER" }).author).toBe("bot");
    expect(message({ ...plain, user: "USLACKBOT" }).author).toBe("bot");
    expect(message({ ...plain, user: "UHELPER" }).author).toBe("bot");
  });

  test("joins, topic changes and subtypes the bridge doesn't know are notices", () => {
    expect(message({ ...plain, subtype: "channel_join" }).author).toBe("notice");
    expect(message({ ...plain, user: "UBOT", subtype: "channel_join" }).author).toBe("notice");
    expect(message({ ...plain, subtype: "channel_topic", topic: "<@UBOT>" }).author).toBe("notice");
    expect(message({ ...plain, subtype: "a_subtype_from_next_year" }).author).toBe("notice");
    expect(message({ ...plain, user: undefined }).author).toBe("notice");
  });

  test("mentions are people only, sorted and without repeats", () => {
    const mentioned = message({
      ...plain,
      text: "<@WALICE|alice> and <@UBOB>, see <@UBOB> <!here> <!subteam^S1|@team> <#C2|general>",
    });
    expect(mentioned).toMatchObject({ mentions: ["UBOB", "WALICE"], mentionsBot: false });
    expect(message({ ...plain, text: "<@UBOT> what's new?" })).toMatchObject({
      mentions: ["UBOT"],
      mentionsBot: true,
    });
  });

  test("history messages normalize like live ones, in the channel they were read from", () => {
    expect(normalizeHistoryMessage("C1", { ...plain, type: "message" }, context)).toEqual(
      normalize({ type: "message", channel: "C1", ...plain }),
    );
  });
});

describe("message event payloads", () => {
  const parses = (event: Record<string, unknown>) =>
    slackMessageEventSchema.safeParse({ type: "message", channel: "C1", ...event }).success;

  test("an event missing what its shape needs is malformed", () => {
    expect(parses({ subtype: "message_changed", ts: plain.ts })).toBe(false);
    expect(parses({ subtype: "message_deleted", ts: plain.ts })).toBe(false);
    expect(parses({ subtype: "message_replied", ts: plain.ts })).toBe(false);
    expect(parses({ ...plain, ts: undefined })).toBe(false);
    expect(parses({ ...plain, ts: 1700000000.0001 })).toBe(false);
    expect(parses({ ...plain, thread_ts: "yesterday" })).toBe(false);
    expect(parses({ ...plain, channel: undefined })).toBe(false);
    expect(parses({ ...plain, files: [{ name: "no id" }] })).toBe(false);
  });

  test("fields Slack adds or leaves null don't make an event malformed", () => {
    expect(parses({ ...plain, blocks: [], client_msg_id: "x", brand_new_field: { a: 1 } })).toBe(
      true,
    );
    expect(
      parses({ ...plain, bot_id: null, team: null, thread_ts: null, edited: null, hidden: null }),
    ).toBe(true);
  });
});

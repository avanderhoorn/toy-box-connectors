import { expect, test } from "bun:test";
import {
  normalizeHistoryMessage,
  normalizeMessageEvent,
  slackMessageEventSchema,
  slackMessageSchema,
} from "./messages";

const context = { botUserId: "UBOT", botId: "BBOT" };
const message = { type: "message", user: "UALICE", text: "<@UBOT> help", ts: "1700000000.000100" };
function normalize(event: unknown) {
  return normalizeMessageEvent(slackMessageEventSchema.parse(event), context);
}

test("roots, replies and edits retain exact identity and routing context", () => {
  expect(
    normalize({ ...message, channel: "C1", thread_ts: message.ts, user_team: "TSIBLING" }),
  ).toMatchObject({
    message: { rootTs: message.ts, isReply: false, teamId: "TSIBLING", mentionsBot: true },
  });
  const reply = { ...message, ts: "1700000000.000101", thread_ts: message.ts };
  expect(normalize({ ...reply, channel: "C1" })).toMatchObject({
    message: { rootTs: message.ts, isReply: true },
  });
  const edited = { ...reply, edited: { ts: "1700000000.000102" } };
  expect(
    normalize({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      hidden: true,
      message: edited,
    }),
  ).toMatchObject({ message: { version: edited.edited.ts } });
  expect(normalizeHistoryMessage("C1", slackMessageSchema.parse(edited), context)).toMatchObject({
    message: { channelId: "C1", version: edited.edited.ts },
  });
});

test("deletion tombstones and withdrawals never become executable text", () => {
  for (const payload of [
    { ...message, subtype: "tombstone", hidden: true },
    { ...message, subtype: "ekm_access_denied" },
    { ...message, user: "UREVOKEDU" },
    { ...message, hidden: true },
  ]) {
    expect(normalize({ ...payload, channel: "C1" })).toEqual({
      kind: "deleted",
      channelId: "C1",
      ts: message.ts,
    });
  }
  expect(
    normalize({
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      deleted_ts: message.ts,
    }),
  ).toEqual({ kind: "deleted", channelId: "C1", ts: message.ts });
  expect(
    normalize({ type: "message", subtype: "message_replied", channel: "C1", message }),
  ).toEqual({ kind: "replied" });
});

test.each([
  [{ user: "UBOT" }, "self"],
  [{ bot_id: "BOTHER" }, "bot"],
  [{ app_id: "AOTHER" }, "bot"],
  [{ user: "USLACKBOT" }, "bot"],
  [{ subtype: "channel_join" }, "notice"],
  [{ subtype: "file_share" }, "person"],
])("authorship, not just subtype, prevents bot loops", (fields, author) => {
  expect(normalize({ ...message, ...fields, channel: "C1" })).toMatchObject({
    message: { author },
  });
});

test("malformed core fields refuse, additive fields and file attachments are ignored", () => {
  expect(slackMessageEventSchema.safeParse({ ...message, channel: "C1", ts: 1.1 }).success).toBe(
    false,
  );
  expect(
    slackMessageEventSchema.safeParse({ ...message, channel: "C1", subtype: "message_changed" })
      .success,
  ).toBe(false);
  expect(
    slackMessageSchema.parse({ ...message, files: [{ id: "F1" }], future_field: true }),
  ).not.toHaveProperty("files");
});

test("mentions read once each, with or without a label", () => {
  expect(
    normalize({
      ...message,
      channel: "C1",
      text: "<@UBOT|toy-box> ask <@UALICE> and <@UALICE|al>",
    }),
  ).toMatchObject({ message: { mentions: ["UALICE", "UBOT"], mentionsBot: true } });
});

test("unclosed markup can't stall reading a message", () => {
  const started = performance.now();
  normalize({ ...message, channel: "C1", text: "<@UA|".repeat(40_000) });
  expect(performance.now() - started).toBeLessThan(500);
});

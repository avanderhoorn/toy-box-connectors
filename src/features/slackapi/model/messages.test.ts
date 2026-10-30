import { expect, test } from "bun:test";
import {
  normalizeHistoryMessage,
  normalizeMessageEvent,
  slackMessageEventSchema,
  slackMessageSchema,
} from "./messages";

const context = { botUserId: "UBOT", botId: "BBOT" };
const message = { type: "message", user: "UALICE", text: "<@UBOT> help", ts: "1700000000.000100" };
const upload = {
  id: "F1",
  name: "build.png",
  mimetype: "image/png",
  pretty_type: "PNG",
  mode: "hosted",
  size: 412_000,
  user: "UALICE",
  url_private: "https://files.slack.com/files-pri/T1-F1/build.png",
};
const shared = {
  id: "F1",
  whole: true,
  name: "build.png",
  mimeType: "image/png",
  mode: "hosted",
  size: 412_000,
  uploaderId: "UALICE",
};
function normalize(event: unknown) {
  return normalizeMessageEvent(slackMessageEventSchema.parse(event), context);
}

test("roots, replies and edits retain exact identity, routing context and files", () => {
  const root = { ...message, thread_ts: message.ts, files: [upload] };
  expect(normalize({ ...root, channel: "C1" })).toMatchObject({
    message: { rootTs: message.ts, isReply: false, mentionsBot: true, files: [shared] },
  });
  const reply = { ...root, ts: "1700000000.000101" };
  expect(normalize({ ...reply, channel: "C1" })).toMatchObject({
    message: { rootTs: message.ts, isReply: true, files: [shared] },
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
  ).toMatchObject({ message: { version: edited.edited.ts, files: [shared] } });
  expect(normalizeHistoryMessage("C1", slackMessageSchema.parse(edited), context)).toMatchObject({
    message: { channelId: "C1", version: edited.edited.ts, files: [shared] },
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
])("authorship, not just subtype, prevents bot loops: %j means %s", (fields, author) => {
  expect(normalize({ ...message, ...fields, channel: "C1" })).toMatchObject({
    message: { author },
  });
});

test("malformed core fields refuse, while additive fields, odd files and deleted ones are ignored", () => {
  expect(slackMessageEventSchema.safeParse({ ...message, channel: "C1", ts: 1.1 }).success).toBe(
    false,
  );
  expect(
    slackMessageEventSchema.safeParse({ ...message, channel: "C1", subtype: "message_changed" })
      .success,
  ).toBe(false);
  const files = [
    { ...upload, id: "F2", file_access: "check_file_info" },
    { ...upload, id: "F3", size: "412 KB" },
    { ...upload, id: "F4", mode: "tombstone" },
    { ...upload, id: "F5", is_deleted: true },
    { ...upload, id: "F6", is_tombstoned: true },
    { ...upload, id: 7 },
    "F8",
    upload,
    { ...upload, name: "again.png" },
  ];
  const parsed = normalize({ ...message, channel: "C1", files, future_field: true });
  expect(parsed).toMatchObject({ message: { text: message.text } });
  expect(parsed).toHaveProperty("message.files", [
    { id: "F2", whole: false },
    { id: "F3", whole: false },
    shared,
  ]);
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

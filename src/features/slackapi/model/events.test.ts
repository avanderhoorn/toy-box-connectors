import { expect, test } from "bun:test";
import { readSlackEvent } from "./events";

test("event decoding retains lifecycle targets and never repeats malformed content", () => {
  expect(
    readSlackEvent({ type: "channel_id_changed", old_channel_id: "G1", new_channel_id: "C2" }),
  ).toMatchObject({ kind: "channel_id_changed", oldChannelId: "G1", newChannelId: "C2" });
  expect(readSlackEvent({ type: "tokens_revoked", tokens: { bot: ["UBOT"] } })).toEqual({
    kind: "tokens_revoked",
    botUserIds: ["UBOT"],
  });
  const result = readSlackEvent({
    type: "message",
    channel: "C1",
    ts: "bad",
    text: "private content",
  });
  expect(result).toMatchObject({ kind: "malformed", channelId: "C1" });
  expect(JSON.stringify(result)).not.toContain("private content");
  expect(readSlackEvent({ type: "toString" })).toEqual({ kind: "other" });
});

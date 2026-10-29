import { expect, test } from "bun:test";
import type { SlackCall } from "@slackapi/server/botClient";
import {
  deleteReceipt,
  nextReconciliation,
  outboxMetadata,
  postSettlement,
  reconciliationReceipt,
} from "./delivery";

const identity = { appId: "A1", botId: "B1" };
const post = { id: "outbox-1", payloadHash: "hash", channelId: "C1", threadTs: "100.1" };
const message = {
  ts: "101.1",
  thread_ts: post.threadTs,
  bot_id: identity.botId,
  app_id: identity.appId,
  text: "answer",
  metadata: outboxMetadata(post),
};
const receipt = { ok: true, channel: post.channelId, ts: message.ts, message };
const settle = (call: SlackCall<unknown>) => postSettlement(call, post, identity);

test("ambiguous writes never become retryable, while explicit refusals do", () => {
  for (const error of ["internal_error", "fatal_error", "service_unavailable"]) {
    expect(settle({ kind: "error", error, data: { ok: false } }).state).toBe("delivery_unknown");
  }
  expect(settle({ kind: "unknown", detail: "private response content" })).toEqual({
    state: "delivery_unknown",
    error: "unverified_slack_response",
  });
  expect(settle({ kind: "rate_limited", until: 60_000 })).toMatchObject({
    state: "queued",
    nextAttemptAt: 60_000,
  });
  expect(settle({ kind: "error", error: "invalid_blocks", data: { ok: false } }).state).toBe(
    "failed",
  );
});
test("a response confirms only the intended bot post and destination", () => {
  const accepted = (result: object) => settle({ kind: "ok", result });
  expect(accepted(receipt)).toEqual({ state: "sent", slackTs: message.ts });
  expect(accepted({ ...receipt, message: { ...message, metadata: undefined } }).state).toBe("sent");
  expect(accepted({ ...receipt, message: { ...message, thread_ts: undefined } })).toEqual({
    state: "delivery_unknown",
    error: "wrong_thread",
    slackTs: message.ts,
  });
  for (const [changed, error] of [
    [{ ...receipt, channel: "COTHER" }, "wrong_channel"],
    [{ ...receipt, message: { ...message, bot_id: "BOTHER" } }, "wrong_author"],
    [{ ...receipt, ts: "102.1" }, "invalid_response"],
    [{ ok: true, channel: "C1" }, "invalid_response"],
  ] as const)
    expect(accepted(changed)).toEqual({ state: "delivery_unknown", error });
});
test("read proof requires exact metadata, our identity, live content and the intended thread", () => {
  expect(reconciliationReceipt(message, "C1", post, identity)).toBe(message.ts);
  for (const changed of [
    { metadata: undefined },
    { metadata: outboxMetadata({ ...post, id: "other" }) },
    { metadata: outboxMetadata({ ...post, payloadHash: "other" }) },
    { bot_id: "BOTHER" },
    { bot_id: undefined },
    { app_id: "AOTHER" },
    { channel: "COTHER" },
    { thread_ts: undefined },
    { subtype: "thread_broadcast" },
    { subtype: "tombstone" },
    { hidden: true },
    { user: "UREVOKEDU" },
  ])
    expect(reconciliationReceipt({ ...message, ...changed }, "C1", post, identity)).toBeNull();
});
test("there are exactly two scheduled checks, and deletion names one exact target", () => {
  expect([0, 1, 2].map((pass) => nextReconciliation(1000, pass))).toEqual([61_000, 301_000, null]);
  expect(
    deleteReceipt({ ok: true, channel: "C1", ts: "101.1" }, { channelId: "C1", ts: "101.1" }),
  ).toBe(true);
  expect(
    deleteReceipt({ ok: true, channel: "C1", ts: "102.1" }, { channelId: "C1", ts: "101.1" }),
  ).toBe(false);
});

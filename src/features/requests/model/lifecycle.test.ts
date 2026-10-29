import { expect, test } from "bun:test";
import {
  beginAnswer,
  cancelRequest,
  changeRequest,
  confirmAnswer,
  dismissRequest,
  expireRequest,
  isActive,
  openRequest,
  requestLifetimeMs,
  returnToSeen,
  serveRequest,
  type NewRequest,
} from "./lifecycle";

const source: NewRequest = {
  linkId: "link",
  channelId: "C-link",
  rootTs: "1700000100.000100",
  sourceTs: "1700000100.000100",
  requesterUserId: "U-owner",
  reason: "mention",
};
const opened = openRequest(source, 1);
const seen = serveRequest(opened, 10);
const answering = beginAnswer(seen, 20);
const updated = changeRequest(seen, 30);

test("a request waits a week for the lead, which can act on it only once it has read it", () => {
  expect(requestLifetimeMs).toBe(7 * 24 * 60 * 60_000);
  expect(opened).toMatchObject({ createdAt: 1, changedAt: 1 });
  expect(changeRequest(opened, 5)).toEqual({ ...opened, changedAt: 5 });
  expect(() => beginAnswer(opened, 5)).toThrow("A request that's open can't be answered.");
  expect(() => dismissRequest(opened, "no question")).toThrow("can't be dismissed");
  expect(answering).toMatchObject({ state: "answering", touchedAt: 20 });
});

test("a change after the lead read a request waits until inbox shows it", () => {
  expect(updated).toMatchObject({ state: "seen", attention: "updated", changedAt: 30 });
  expect(() => beginAnswer(updated, 40)).toThrow("with updated unread can't be answered");
  expect(() => dismissRequest(updated, "done")).toThrow("with updated unread can't be dismissed");
  const reread = serveRequest(updated, 50);
  expect(reread).toMatchObject({ attention: null, touchedAt: 50 });
  expect(beginAnswer(reread, 60).state).toBe("answering");
});

test("an answer in flight ignores changes and can't expire, but a refused one goes back to the lead", () => {
  expect(changeRequest(answering, 30)).toBe(answering);
  expect(() => expireRequest(answering)).toThrow("that's answering can't become expired");
  const failed = returnToSeen(answering, 30);
  expect(failed).toMatchObject({ state: "seen", attention: "reply_failed", changedAt: 30 });
  expect(changeRequest(failed, 40).attention).toBe("reply_failed");
  expect(() => beginAnswer(failed, 50)).toThrow("with reply_failed unread can't be answered");
  expect(beginAnswer(serveRequest(failed, 60), 70).state).toBe("answering");
  expect(() => returnToSeen(opened, 30)).toThrow("A request that's open can't return to the lead.");
});

test("a closed request keeps why it closed and never reopens", () => {
  for (const [closed, state, closedReason] of [
    [confirmAnswer(answering), "answered", null],
    [dismissRequest(seen, "no question"), "dismissed", "no question"],
    [cancelRequest(opened, "mention_removed"), "cancelled", "mention_removed"],
    [cancelRequest(updated, "requester_denied"), "cancelled", "requester_denied"],
    [cancelRequest(answering, "source_deleted"), "cancelled", "source_deleted"],
    [expireRequest(opened), "expired", null],
    [expireRequest(updated), "expired", null],
  ] as const) {
    expect(closed).toMatchObject({ state, attention: null, closedReason });
    expect(isActive(closed.state)).toBe(false);
    expect(changeRequest(closed, 99)).toBe(closed);
    expect(() => beginAnswer(serveRequest(closed, 99), 99)).toThrow("can't be answered");
    expect(() => cancelRequest(closed, "requester_denied")).toThrow("can't become cancelled");
  }
});

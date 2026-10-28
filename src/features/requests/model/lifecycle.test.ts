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
  returnToSeen,
  serveRequest,
} from "./lifecycle";

const opened = openRequest(
  {
    linkId: "link",
    channelId: "C1",
    rootTs: "1700000000.000100",
    sourceTs: "1700000000.000100",
    requesterUserId: "UALICE",
    reason: "mention",
  },
  0,
);
const seen = serveRequest(opened, 10);

test("a request opens waiting on the lead for a week", () => {
  expect(opened).toMatchObject({ state: "open", attention: null, touchedAt: null });
  expect(opened.expiresAt).toBe(7 * 24 * 60 * 60_000);
  expect(changeRequest(opened, 5)).toEqual({ ...opened, changedAt: 5 });
});

test("the lead can answer or dismiss only a request it has read", () => {
  expect(() => beginAnswer(opened, 5)).toThrow("A request that's open can't be answered.");
  expect(() => dismissRequest(opened, "no question")).toThrow("can't be dismissed");
  expect(seen).toMatchObject({ state: "seen", touchedAt: 10 });
  expect(beginAnswer(seen, 20)).toMatchObject({ state: "answering", touchedAt: 20 });
  expect(dismissRequest(seen, "no question")).toMatchObject({
    state: "dismissed",
    closedReason: "no question",
  });
});

test("a change after the lead read a request waits until inbox shows it", () => {
  const updated = changeRequest(seen, 20);
  expect(updated).toMatchObject({ state: "seen", attention: "updated", changedAt: 20 });
  expect(() => beginAnswer(updated, 30)).toThrow("with updated unread can't be answered");
  expect(() => dismissRequest(updated, "done")).toThrow("with updated unread can't be dismissed");
  const reread = serveRequest(updated, 40);
  expect(reread).toMatchObject({ attention: null, touchedAt: 40 });
  expect(beginAnswer(reread, 50).state).toBe("answering");
});

test("once the lead answers, changes are ignored, and only Slack's confirmation answers it", () => {
  const answering = beginAnswer(seen, 20);
  expect(changeRequest(answering, 30)).toBe(answering);
  expect(isActive(answering.state)).toBe(true);
  expect(confirmAnswer(answering)).toMatchObject({ state: "answered", closedReason: null });
  expect(() => confirmAnswer(seen)).toThrow("A request that's seen can't become answered.");
});

test("a refused reply goes back to the lead, who must read why before answering again", () => {
  const failed = returnToSeen(beginAnswer(seen, 20), 30);
  expect(failed).toMatchObject({ state: "seen", attention: "reply_failed", changedAt: 30 });
  expect(changeRequest(failed, 40).attention).toBe("reply_failed");
  expect(() => beginAnswer(failed, 50)).toThrow("with reply_failed unread can't be answered");
  expect(beginAnswer(serveRequest(failed, 60), 70).state).toBe("answering");
  expect(() => returnToSeen(seen, 30)).toThrow("A request that's seen can't return to the lead.");
});

test("a request whose reply is in flight can be cancelled but can't expire", () => {
  const answering = beginAnswer(seen, 20);
  expect(cancelRequest(answering, "source_deleted")).toMatchObject({
    state: "cancelled",
    closedReason: "source_deleted",
  });
  expect(() => expireRequest(answering)).toThrow("can't become expired");
  expect(expireRequest(changeRequest(seen, 20))).toMatchObject({
    state: "expired",
    attention: null,
  });
});

test("answered, dismissed, cancelled and expired requests never reopen", () => {
  for (const finished of [
    confirmAnswer(beginAnswer(seen, 20)),
    dismissRequest(seen, "no question"),
    cancelRequest(opened, "mention_removed"),
    expireRequest(opened),
  ]) {
    expect(isActive(finished.state)).toBe(false);
    expect(changeRequest(finished, 99)).toBe(finished);
    expect(() => beginAnswer(serveRequest(finished, 99), 99)).toThrow("can't be answered");
    expect(() => cancelRequest(finished, "link_removed")).toThrow("can't become cancelled");
  }
});

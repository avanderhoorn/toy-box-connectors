import { describe, expect, test } from "bun:test";
import type { SlackMessage } from "@slackapi/model/messages";
import { classify, type ClassifyFacts } from "./classify";

const now = 1_700_100_000_000;

const ask: SlackMessage = {
  channelId: "C1",
  ts: "1700099000.000100",
  threadTs: null,
  rootTs: "1700099000.000100",
  isReply: false,
  userId: "UALICE",
  teamId: "THOME",
  subtype: null,
  author: "person",
  text: "<@UBOT> can you check the build?",
  mentions: ["UBOT"],
  mentionsBot: true,
  editedTs: null,
  version: "1700099000.000100",
};

const reply: SlackMessage = {
  ...ask,
  ts: "1700099500.000200",
  threadTs: "1700099000.000100",
  isReply: true,
  version: "1700099500.000200",
  text: "it fails on the lint step too",
  mentions: [],
  mentionsBot: false,
};

const facts: ClassifyFacts = {
  link: {
    status: "active",
    requestMode: "mention",
    linkedAtTs: "1699000000.000100",
  },
  role: "allowed",
  active: null,
  askedBefore: false,
  firstSight: true,
  now,
};

describe("who may ask", () => {
  test("an allowlisted person who mentions the bot opens a request", () => {
    expect(classify(ask, facts)).toEqual({ kind: "request", reason: "mention" });
  });

  test("a paused or suspended link opens nothing, but a requester can still add to a request", () => {
    for (const status of ["paused", "suspended"] as const) {
      const inactive = { ...facts, link: { ...facts.link, status } };
      expect(classify(ask, inactive)).toEqual({ kind: "none", reason: "link_inactive" });
      expect(classify(reply, { ...inactive, askedBefore: true })).toEqual({
        kind: "none",
        reason: "link_inactive",
      });
      expect(classify(reply, { ...inactive, active: { id: 4, sourceTs: ask.ts } })).toEqual({
        kind: "join",
        requestId: 4,
      });
    }
  });

  test("bots, notices and our own posts never ask", () => {
    for (const author of ["self", "bot", "notice"] as const) {
      expect(classify({ ...ask, author }, facts)).toEqual({
        kind: "none",
        reason: "not_a_person",
      });
    }
  });

  test("an allowlisted person asks from any workspace the message names", () => {
    for (const teamId of ["TSIBLING", null]) {
      expect(classify({ ...ask, teamId }, facts)).toEqual({ kind: "request", reason: "mention" });
    }
  });

  test("a message from before the link, or from the moment it was made, never asks", () => {
    const linkedAtTs = facts.link.linkedAtTs;
    for (const ts of ["999999999.000100", "1698999999.000100", linkedAtTs]) {
      expect(classify({ ...ask, ts }, facts)).toEqual({ kind: "none", reason: "before_link" });
    }
    const edited = { ...facts, firstSight: false };
    expect(classify({ ...ask, ts: "1699000000.000101" }, edited).kind).toBe("request");
  });

  test("a message older than a week when first seen never asks, but an edit to it can", () => {
    const old = { ...ask, ts: "1699495199.999999" };
    expect(classify(old, facts)).toEqual({ kind: "none", reason: "too_old" });
    expect(classify(old, { ...facts, firstSight: false }).kind).toBe("request");
    expect(classify({ ...ask, ts: "1699495200.000000" }, facts).kind).toBe("request");
  });

  test("someone not on the allowlist gets no request, even mentioning the bot", () => {
    expect(classify(ask, { ...facts, role: "observed" })).toEqual({
      kind: "none",
      reason: "not_allowlisted",
    });
    expect(
      classify(reply, { ...facts, role: "observed", active: { id: 4, sourceTs: ask.ts } }),
    ).toEqual({ kind: "none", reason: "not_allowlisted" });
  });
});

describe("what counts as asking", () => {
  test("a thank-you or a lone emoji isn't a request, even mentioning the bot", () => {
    expect(classify({ ...ask, text: "<@UBOT> thanks!" }, facts)).toEqual({
      kind: "none",
      reason: "courtesy",
    });
    expect(
      classify({ ...reply, text: ":tada:" }, { ...facts, active: { id: 4, sourceTs: ask.ts } }),
    ).toEqual({ kind: "none", reason: "courtesy" });
  });

  test("a message addressed only to other people isn't for the bot", () => {
    const toBob = { ...reply, text: "<@UBOB> can you look?", mentions: ["UBOB"] };
    expect(classify(toBob, { ...facts, active: { id: 4, sourceTs: ask.ts } })).toEqual({
      kind: "none",
      reason: "addressed_to_others",
    });
    expect(classify({ ...toBob, mentions: ["UBOB", "UBOT"], mentionsBot: true }, facts)).toEqual({
      kind: "request",
      reason: "mention",
    });
  });

  test("a later message from the requester joins their active request in the thread", () => {
    expect(classify(reply, { ...facts, active: { id: 4, sourceTs: ask.ts } })).toEqual({
      kind: "join",
      requestId: 4,
    });
    const again = {
      ...reply,
      text: "<@UBOT> also the tests",
      mentions: ["UBOT"],
      mentionsBot: true,
    };
    expect(classify(again, { ...facts, active: { id: 4, sourceTs: ask.ts } })).toEqual({
      kind: "join",
      requestId: 4,
    });
  });

  test("a message from before the active request began, found late, stays context", () => {
    const earlier = { ...reply, ts: "1700099000.000050" };
    const active = { id: 4, sourceTs: "1700099500.000100" };
    expect(classify(earlier, { ...facts, active })).toEqual({
      kind: "none",
      reason: "before_request",
    });
    expect(classify({ ...reply, ts: active.sourceTs }, { ...facts, active })).toEqual({
      kind: "none",
      reason: "before_request",
    });
  });

  test("a reply in a thread where the requester asked before is a follow-up", () => {
    expect(classify(reply, { ...facts, askedBefore: true })).toEqual({
      kind: "request",
      reason: "follow_up",
    });
    expect(classify(reply, facts)).toEqual({ kind: "none", reason: "context_only" });
  });

  test("a root message is a follow-up to nothing", () => {
    const root = { ...ask, text: "the build is red", mentions: [], mentionsBot: false };
    expect(classify(root, { ...facts, askedBefore: true })).toEqual({
      kind: "none",
      reason: "context_only",
    });
  });

  test("in all mode every root message asks, but replies still need a mention or a past ask", () => {
    const all = { ...facts, link: { ...facts.link, requestMode: "all" as const } };
    const root = { ...ask, text: "the build is red", mentions: [], mentionsBot: false };
    expect(classify(root, all)).toEqual({ kind: "request", reason: "channel_root" });
    expect(classify(reply, all)).toEqual({ kind: "none", reason: "context_only" });
    expect(classify(root, facts)).toEqual({ kind: "none", reason: "context_only" });
  });
});

import { expect, test } from "bun:test";
import type { SlackMessage } from "@slackapi/model/messages";
import { askMessage, replyMessage } from "@slackapi/model/testFixtures";
import { tsAt } from "@slackapi/model/ts";
import { classify, type Classification, type ClassifyFacts, type NoneReason } from "./classify";
import { requestLifetimeMs, type RequestReason } from "./lifecycle";

const facts: ClassifyFacts = {
  link: { status: "active", requestMode: "mention", linkedAtTs: "1699000000.000100" },
  role: "allowed",
  active: null,
  askedBefore: false,
  firstSight: true,
  now: 1_700_000_300_000,
};
const paused = { ...facts.link, status: "paused" as const };
const all = { ...facts.link, requestMode: "all" as const };

const ask = askMessage();
const reply = replyMessage(ask, "1700000200.000100");
const root = { ...ask, text: "the deploy is red", mentions: [], mentionsBot: false };
const tada = { ...reply, text: ":tada:" };
const toBob = { ...reply, text: "<@U-bob> can you look?", mentions: ["U-bob"] };
const toBoth = { ...toBob, mentions: ["U-bob", "U-bot"], mentionsBot: true };
const atLink = askMessage(facts.link.linkedAtTs);
const weekOld = askMessage(tsAt(facts.now - requestLifetimeMs));
const tooOld = askMessage(tsAt(facts.now - requestLifetimeMs - 1));
const active = { id: 4, sourceTs: ask.ts };
const later = { id: 4, sourceTs: reply.ts };

const none = (reason: NoneReason): Classification => ({ kind: "none", reason });
const asks = (reason: RequestReason): Classification => ({ kind: "request", reason });
const joins: Classification = { kind: "join", requestId: 4 };

test.each<[string, SlackMessage, Partial<ClassifyFacts>, Classification]>([
  ["an allowlisted person who mentions the bot asks", ask, {}, asks("mention")],
  ["our own posts never ask", { ...ask, author: "self" }, {}, none("not_a_person")],
  ["nothing up to the moment of linking asks", atLink, { firstSight: false }, none("before_link")],
  ["a message first seen over a week late never asks", tooOld, {}, none("too_old")],
  ["but an edit to it can", tooOld, { firstSight: false }, asks("mention")],
  ["and one first seen a week late can", weekOld, {}, asks("mention")],
  ["someone not on the allowlist never asks", ask, { role: "observed" }, none("not_allowlisted")],
  ["nor adds to a request", reply, { role: "observed", active }, none("not_allowlisted")],
  ["a thank-you isn't a request", { ...ask, text: "<@U-bot> thanks!" }, {}, none("courtesy")],
  ["nor is a lone emoji in a request's thread", tada, { active }, none("courtesy")],
  ["a message for other people isn't for the bot", toBob, { active }, none("addressed_to_others")],
  ["one for them and the bot is", toBoth, {}, asks("mention")],
  ["the requester's later messages join their request", toBoth, { active }, joins],
  ["but not one found late from before it", reply, { active: later }, none("before_request")],
  ["a paused link opens nothing", ask, { link: paused }, none("link_inactive")],
  ["but a requester can still add to their request", reply, { link: paused, active }, joins],
  ["a reply after an earlier ask follows up", reply, { askedBefore: true }, asks("follow_up")],
  ["any other reply is context", reply, {}, none("context_only")],
  ["a root message follows up nothing", root, { askedBefore: true }, none("context_only")],
  ["in all mode every root message asks", root, { link: all }, asks("channel_root")],
  ["but a reply still needs a mention or a past ask", reply, { link: all }, none("context_only")],
])("%s", (_, message, changes, expected) => {
  expect(classify(message, { ...facts, ...changes })).toEqual(expected);
});

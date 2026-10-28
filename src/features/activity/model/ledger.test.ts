import { expect, test } from "bun:test";
import { askMessage } from "@slackapi/model/testFixtures";
import {
  authorRole,
  fingerprintSource,
  keepsText,
  mergeDelete,
  mergeSnapshot,
  type AuthorRole,
  type LinkAudience,
  type MergeDecision,
  type StoredMessage,
} from "./ledger";

const audience: LinkAudience = { allowlist: new Set(["U-owner"]), observe: "requesters" };
const message = askMessage();

test("a person is allowed by exact user ID, whatever workspace the message names", () => {
  expect(authorRole(message, audience)).toBe("allowed");
  expect(authorRole({ ...message, teamId: "T-sibling" }, audience)).toBe("allowed");
  expect(authorRole({ ...message, userId: "U-stranger" }, audience)).toBe("observed");
  expect(authorRole({ ...message, userId: null }, audience)).toBe("observed");
  expect(authorRole({ ...message, author: "self" }, audience)).toBe("self");
  expect(authorRole({ ...message, author: "bot" }, audience)).toBe("other");
  expect(authorRole({ ...message, author: "notice" }, audience)).toBe("other");
});

test.each<[AuthorRole, LinkAudience["observe"], boolean, boolean]>([
  ["allowed", "requesters", false, true],
  ["self", "requesters", false, true],
  ["observed", "requesters", false, false],
  ["observed", "requesters", true, true],
  ["observed", "channel", false, true],
  ["other", "channel", true, false],
])(
  "the ledger keeps text by %s in %s mode, in a request thread %p: %p",
  (role, observe, inThread, keeps) => {
    expect(keepsText(role, observe, inThread)).toBe(keeps);
  },
);

test("only text and mentions are a message's content, compared exactly", () => {
  const content = fingerprintSource(message);
  expect(fingerprintSource({ ...message, text: `${message.text} ` })).not.toBe(content);
  expect(fingerprintSource({ ...message, mentions: [] })).not.toBe(content);
  expect(
    fingerprintSource({
      ...message,
      editedTs: "1700000150.000100",
      version: "1700000150.000100",
      author: "bot",
    }),
  ).toBe(content);
});

const [v1, v2] = ["1700000100.000100", "1700000150.000100"];
const kept: StoredMessage = { version: v1, deleted: false, contentHash: "a" };
const edited: StoredMessage = { ...kept, version: v2, contentHash: "b" };
const marker: StoredMessage = { ...kept, contentHash: null };
const tombstone: StoredMessage = { ...marker, deleted: true };
const nines: StoredMessage = { ...kept, version: "999999999.900000" };
const ignored = (reason: "duplicate" | "older" | "tombstoned"): MergeDecision => ({
  kind: "ignore",
  reason,
});
const updated = (change: "edited" | null): MergeDecision => ({ kind: "update", change });

test.each<[string, StoredMessage | null, string, string | null, MergeDecision]>([
  ["a message first seen is new", null, v1, "a", { kind: "insert", change: "new" }],
  ["a redelivery is a duplicate", kept, v1, "a", ignored("duplicate")],
  ["an older version never wins", edited, v1, "a", ignored("older")],
  ["a later version with new content is an edit", kept, v2, "b", updated("edited")],
  ["a later version with the same content is quiet", kept, v2, "a", updated(null)],
  ["kept text becoming a marker is an edit", kept, v2, null, updated("edited")],
  ["a marker its thread now keeps fills in quietly", marker, v1, "a", updated(null)],
  ["a marker redelivered as a marker is a duplicate", marker, v1, null, ignored("duplicate")],
  ["kept text isn't lost to a marker's redelivery", kept, v1, null, ignored("duplicate")],
  ["a tombstone outlives any version", tombstone, v2, "b", ignored("tombstoned")],
  ["versions compare as decimals", nines, "1000000000.000000", "a", updated(null)],
])("%s", (_, stored, version, contentHash, decision) => {
  expect(mergeSnapshot(stored, { version, contentHash })).toEqual(decision);
});

test("a delete tombstones a message once, even one the ledger hasn't seen yet", () => {
  expect(mergeDelete(null)).toEqual({ kind: "insert", change: "deleted" });
  expect(mergeDelete(marker)).toEqual({ kind: "update", change: "deleted" });
  expect(mergeDelete(tombstone)).toEqual(ignored("duplicate"));
});

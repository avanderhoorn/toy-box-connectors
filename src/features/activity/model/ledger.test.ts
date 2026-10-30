import { expect, test } from "bun:test";
import { askMessage } from "@slackapi/model/testFixtures";
import {
  authorRole,
  mergeSnapshot,
  type LinkAudience,
  type MergeDecision,
  type StoredMessage,
} from "./ledger";

const audience: LinkAudience = { allowlist: new Set(["U-owner"]), observe: "requesters" };
const message = askMessage();

test("a person is allowed by exact user ID", () => {
  expect(authorRole(message, audience)).toBe("allowed");
  expect(authorRole({ ...message, userId: "U-stranger" }, audience)).toBe("observed");
  expect(authorRole({ ...message, userId: null }, audience)).toBe("observed");
  expect(authorRole({ ...message, author: "self" }, audience)).toBe("self");
  expect(authorRole({ ...message, author: "bot" }, audience)).toBe("other");
  expect(authorRole({ ...message, author: "notice" }, audience)).toBe("other");
});

const [v1, v2] = ["1700000100.000100", "1700000150.000100"];
const kept: StoredMessage = { version: v1, deleted: false, contentHash: "a" };
const edited: StoredMessage = { ...kept, version: v2, contentHash: "b" };
const ignored = (reason: "duplicate" | "older" | "tombstoned"): MergeDecision => ({
  kind: "ignore",
  reason,
});
const updated = (change: "edited" | null): MergeDecision => ({ kind: "update", change });

test.each<[string, StoredMessage | null, string, string | null, MergeDecision]>([
  ["an older version never wins", edited, v1, "a", ignored("older")],
  ["a later version with the same content is quiet", kept, v2, "a", updated(null)],
  ["kept text isn't lost to a marker's redelivery", kept, v1, null, ignored("duplicate")],
])("%s", (_, stored, version, contentHash, decision) => {
  expect(mergeSnapshot(stored, { version, contentHash })).toEqual(decision);
});

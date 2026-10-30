import { expect, test } from "bun:test";
import type { SlackFile } from "@slackapi/model/files";
import { askMessage, sharedFile } from "@slackapi/model/testFixtures";
import {
  authorRole,
  fingerprintSource,
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

const sourceSharing = (...files: SlackFile[]) => fingerprintSource({ ...message, files });
const [f1, f2] = [sharedFile("F1"), sharedFile("F2")];

test.each<[string, string, SlackFile[], boolean]>([
  [
    "a message without files hashes as the ledger stored it before it kept files",
    JSON.stringify([message.text, message.mentions]),
    [],
    false,
  ],
  ["swapping a file under the same caption is an edit", sourceSharing(f1), [f2], true],
  ["sharing the same files in another order isn't", sourceSharing(f1, f2), [f2, f1], false],
])("%s", (_, stored, files, edited) => {
  expect(sourceSharing(...files) !== stored).toBe(edited);
});

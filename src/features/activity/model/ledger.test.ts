import { describe, expect, test } from "bun:test";
import type { SlackMessage } from "@slackapi/model/messages";
import {
  authorRole,
  fingerprintSource,
  keepsText,
  mergeDelete,
  mergeSnapshot,
  mergeWithdrawal,
  type LinkAudience,
  type StoredMessage,
} from "./ledger";

const audience: LinkAudience = {
  ownerUserId: "UOWNER",
  allowlist: new Set(["UALLOWED"]),
  observe: "requesters",
};

const message: SlackMessage = {
  channelId: "C1",
  ts: "1700000000.000100",
  threadTs: null,
  rootTs: "1700000000.000100",
  isReply: false,
  userId: "UALLOWED",
  teamId: "THOME",
  subtype: null,
  author: "person",
  text: "<@UBOT> can you check the build?",
  files: [],
  mentions: ["UBOT"],
  mentionsBot: true,
  editedTs: null,
  version: "1700000000.000100",
  latestReplyTs: null,
};

describe("author roles", () => {
  test("the owner and allowlisted people in our team are named, and other people observed", () => {
    expect(authorRole({ ...message, userId: "UOWNER" }, audience)).toBe("owner");
    expect(authorRole(message, audience)).toBe("allowed");
    expect(authorRole({ ...message, userId: "USOMEONE" }, audience)).toBe("observed");
  });

  test("the owner is the owner even when the allowlist names them too", () => {
    const listed = { ...audience, allowlist: new Set(["UOWNER"]) };
    expect(authorRole({ ...message, userId: "UOWNER" }, listed)).toBe("owner");
  });

  test("a person is matched by user ID, whatever workspace the message names", () => {
    expect(authorRole({ ...message, teamId: "TSIBLING" }, audience)).toBe("allowed");
    expect(authorRole({ ...message, userId: "UOWNER", teamId: null }, audience)).toBe("owner");
  });

  test("a person without a user ID is never the owner, even before one is pinned", () => {
    const unclaimed = { ...audience, ownerUserId: null };
    expect(authorRole({ ...message, userId: null }, unclaimed)).toBe("observed");
  });

  test("our bot is self, and other bots and notices are other", () => {
    expect(authorRole({ ...message, author: "self" }, audience)).toBe("self");
    expect(authorRole({ ...message, author: "bot" }, audience)).toBe("other");
    expect(authorRole({ ...message, author: "notice", userId: "UOWNER" }, audience)).toBe("other");
  });
});

describe("keeping text", () => {
  test("the owner, allowlisted people and our bot are always kept, other bots never", () => {
    for (const observe of ["requesters", "channel"] as const) {
      for (const inThread of [false, true]) {
        expect(keepsText("owner", observe, inThread)).toBe(true);
        expect(keepsText("allowed", observe, inThread)).toBe(true);
        expect(keepsText("self", observe, inThread)).toBe(true);
        expect(keepsText("other", observe, inThread)).toBe(false);
      }
    }
  });

  test("requesters mode keeps an observed person only inside a request thread", () => {
    expect(keepsText("observed", "requesters", false)).toBe(false);
    expect(keepsText("observed", "requesters", true)).toBe(true);
    expect(keepsText("observed", "channel", false)).toBe(true);
  });
});

describe("fingerprints", () => {
  const files = [
    { id: "F2", name: "b.txt", mimetype: null, size: 1 },
    { id: "F1", name: "a.txt", mimetype: null, size: 1 },
  ];

  test("text, files and mentions make a message's content", () => {
    const base = fingerprintSource(message);
    expect(fingerprintSource({ ...message, text: "<@UBOT> can you check the deploy?" })).not.toBe(
      base,
    );
    expect(fingerprintSource({ ...message, files })).not.toBe(base);
    expect(fingerprintSource({ ...message, mentions: ["UBOT", "UOTHER"] })).not.toBe(base);
  });

  test("file order, edit stamps, reply counts and authorship aren't content", () => {
    expect(fingerprintSource({ ...message, files })).toBe(
      fingerprintSource({ ...message, files: [...files].reverse() }),
    );
    expect(
      fingerprintSource({
        ...message,
        editedTs: "1700000009.000000",
        version: "1700000009.000000",
        latestReplyTs: "1700000005.000000",
        author: "bot",
      }),
    ).toBe(fingerprintSource(message));
  });

  test("text is compared exactly as sent", () => {
    expect(fingerprintSource({ ...message, text: `${message.text} ` })).not.toBe(
      fingerprintSource(message),
    );
  });
});

describe("merging", () => {
  const stored: StoredMessage = {
    version: "1700000000.000100",
    deleted: false,
    withdrawn: false,
    contentHash: "hash-1",
  };
  const same = { version: stored.version, contentHash: "hash-1" };
  const newer = "1700000050.000000";
  const marker: StoredMessage = { ...stored, contentHash: null };
  const tombstone: StoredMessage = { ...stored, deleted: true, contentHash: null };
  const withdrawn: StoredMessage = { ...tombstone, withdrawn: true };

  test("a message the ledger hasn't seen is inserted as new", () => {
    expect(mergeSnapshot(null, same)).toEqual({ kind: "insert", change: "new" });
  });

  test("redelivering the same version changes nothing", () => {
    expect(mergeSnapshot(stored, same)).toEqual({ kind: "ignore", reason: "duplicate" });
  });

  test("an older version never replaces a newer one", () => {
    const edited = { ...stored, version: newer, contentHash: "hash-2" };
    expect(mergeSnapshot(edited, same)).toEqual({ kind: "ignore", reason: "older" });
    expect(mergeSnapshot({ ...edited, contentHash: null }, same)).toEqual({
      kind: "ignore",
      reason: "older",
    });
  });

  test("a newer version with new content is an edit", () => {
    expect(mergeSnapshot(stored, { version: newer, contentHash: "hash-2" })).toEqual({
      kind: "update",
      change: "edited",
    });
  });

  test("a newer version with the same content updates quietly", () => {
    expect(mergeSnapshot(stored, { ...same, version: newer })).toEqual({
      kind: "update",
      change: null,
    });
  });

  test("a marker edited into a marker updates quietly, and kept text changing either way is an edit", () => {
    expect(mergeSnapshot(marker, { version: newer, contentHash: null })).toEqual({
      kind: "update",
      change: null,
    });
    expect(mergeSnapshot(marker, { version: newer, contentHash: "hash-1" })).toEqual({
      kind: "update",
      change: "edited",
    });
    expect(mergeSnapshot(stored, { version: newer, contentHash: null })).toEqual({
      kind: "update",
      change: "edited",
    });
  });

  test("a marker fills in without a change when its thread now keeps it", () => {
    expect(mergeSnapshot(marker, same)).toEqual({ kind: "update", change: null });
    expect(mergeSnapshot(marker, { ...same, contentHash: null })).toEqual({
      kind: "ignore",
      reason: "duplicate",
    });
    expect(mergeSnapshot(stored, { ...same, contentHash: null })).toEqual({
      kind: "ignore",
      reason: "duplicate",
    });
  });

  test("a delete tombstones a live message once", () => {
    expect(mergeDelete(stored)).toEqual({ kind: "update", change: "deleted" });
    expect(mergeDelete(tombstone)).toEqual({ kind: "ignore", reason: "duplicate" });
  });

  test("a delete that arrives before its message leaves a tombstone the message can't undo", () => {
    expect(mergeDelete(null)).toEqual({ kind: "insert", change: "deleted" });
    expect(mergeSnapshot(tombstone, same)).toEqual({ kind: "ignore", reason: "tombstoned" });
    expect(mergeSnapshot(tombstone, { ...same, version: newer })).toEqual({
      kind: "ignore",
      reason: "tombstoned",
    });
  });

  test("a withdrawal empties a message without a newer edit, and no version brings it back", () => {
    expect(mergeWithdrawal(stored)).toEqual({ kind: "update", change: "withdrawn" });
    expect(mergeWithdrawal(marker)).toEqual({ kind: "update", change: "withdrawn" });
    expect(mergeSnapshot(withdrawn, same)).toEqual({ kind: "ignore", reason: "tombstoned" });
    expect(mergeSnapshot(withdrawn, { version: newer, contentHash: "hash-2" })).toEqual({
      kind: "ignore",
      reason: "tombstoned",
    });
  });

  test("a withdrawal that arrives before its message leaves a tombstone the message can't fill in", () => {
    expect(mergeWithdrawal(null)).toEqual({ kind: "insert", change: "withdrawn" });
  });

  test("a withdrawal is taken once, and leaves a deleted message deleted", () => {
    expect(mergeWithdrawal(withdrawn)).toEqual({ kind: "ignore", reason: "duplicate" });
    expect(mergeWithdrawal(tombstone)).toEqual({ kind: "ignore", reason: "tombstoned" });
  });

  test("a delete turns a withdrawn message into a deleted one", () => {
    expect(mergeDelete(withdrawn)).toEqual({ kind: "update", change: "deleted" });
  });

  test("versions compare as decimals, not as text", () => {
    const at = (version: string): StoredMessage => ({ ...stored, version });
    expect(
      mergeSnapshot(at("999999999.900000"), { ...same, version: "1000000000.000000" }),
    ).toEqual({ kind: "update", change: null });
    expect(mergeSnapshot(at("1700000000.1"), { ...same, version: "1700000000.100000" })).toEqual({
      kind: "ignore",
      reason: "duplicate",
    });
  });
});

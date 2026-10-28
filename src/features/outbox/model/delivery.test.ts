import { expect, test } from "bun:test";
import {
  deleteReceipt,
  messageEvidence,
  nextReconciliation,
  outboxMetadata,
  postReceipt,
  reconciliationReceipt,
  updateReceipt,
  writeOutcome,
  type OutboxPost,
} from "./delivery";

const identity = { appId: "ATEST", botId: "BTEST" };
const post: OutboxPost = {
  id: "outbox-1",
  payloadHash: "a".repeat(64),
  channelId: "CTEST",
  threadTs: "100.000001",
  text: "The answer.",
};

function message(changes: Record<string, unknown> = {}) {
  return {
    type: "message",
    ts: "200.000001",
    thread_ts: post.threadTs,
    bot_id: identity.botId,
    app_id: identity.appId,
    text: post.text,
    metadata: outboxMetadata(post),
    ...changes,
  };
}

function response(changes: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) {
  return {
    ok: true,
    channel: post.channelId,
    ts: "200.000001",
    message: message(changes),
    ...outer,
  };
}

test.each([
  { ok: false, channel: post.channelId, ts: "200.000001" },
  { channel: post.channelId, ts: "200.000001" },
  { ok: true, ts: "200.000001" },
  { ok: true, channel: post.channelId },
  { ok: true, channel: "COTHER", ts: "200.000001" },
  { ok: true, channel: post.channelId, ts: "200.000002" },
  { ok: true, channel: post.channelId, ts: "not-a-ts" },
])("an incomplete or contradictory deletion receipt is not proof: %j", (receipt) => {
  expect(deleteReceipt(receipt, { channelId: post.channelId, ts: "200.000001" })).toBe(false);
});

test("a deletion confirms its exact channel and target without requiring a message echo", () => {
  expect(
    deleteReceipt(
      { ok: true, channel: post.channelId, ts: "200.000001" },
      { channelId: post.channelId, ts: "200.000001" },
    ),
  ).toBe(true);
});

test("a write is accepted only when the shared client got a successful response", () => {
  expect(writeOutcome({ kind: "ok", result: { ok: true, ts: "1.0" } })).toEqual({
    kind: "accepted",
    result: { ok: true, ts: "1.0" },
  });
  expect(writeOutcome({ kind: "rate_limited", until: 60_000 })).toEqual({
    kind: "queued",
    nextAttemptAt: 60_000,
    error: "rate_limited",
  });
  expect(writeOutcome({ kind: "auth_failed", error: "token_expired" })).toEqual({
    kind: "queued",
    nextAttemptAt: null,
    error: "token_expired",
  });
});

test.each(["internal_error", "fatal_error", "service_unavailable"])(
  "%s may have written and is never automatically retried",
  (error) => {
    expect(writeOutcome({ kind: "error", error, data: { ok: false } })).toEqual({
      kind: "delivery_unknown",
      error,
    });
  },
);

test("a lost response stays unknown", () => {
  expect(writeOutcome({ kind: "unknown", detail: "HTTP 503" })).toEqual({
    kind: "delivery_unknown",
    error: "HTTP 503",
  });
});

test("a locally guarded write waits without claiming Slack rejected it or might have accepted it", () => {
  expect(writeOutcome({ kind: "unusable" })).toEqual({
    kind: "queued",
    error: "slack_unusable",
    nextAttemptAt: null,
    called: false,
  });
});

test("an admin refusal keeps the exact code and suspends the whole channel", () => {
  const error = "restricted_action_read_only_channel";
  expect(writeOutcome({ kind: "error", error, data: { ok: false } })).toEqual({
    kind: "failed",
    error,
    suspend: "channel_restricted",
  });
});

test.each([
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "cannot_reply_to_message",
  "thread_not_found",
  "invalid_blocks",
])("%s fails only its item", (error) => {
  expect(writeOutcome({ kind: "error", error, data: { ok: false } })).toEqual({
    kind: "failed",
    error,
    suspend: null,
  });
});

test("metadata carries only the opaque item and payload hash", () => {
  expect(outboxMetadata(post)).toEqual({
    event_type: "toy_box_outbox",
    event_payload: { id: post.id, payload_hash: post.payloadHash },
  });
});

test("the receipt confirms the requested reply and its metadata", () => {
  expect(postReceipt(response(), post, identity)).toEqual({
    kind: "confirmed",
    ts: "200.000001",
    metadataOk: true,
  });
  expect(
    postReceipt(response({ bot_id: undefined, app_id: undefined }), post, identity),
  ).toMatchObject({ kind: "confirmed" });
});

test("a reply at the root, in another thread or broadcast needs withdrawal, not confirmation", () => {
  for (const changes of [
    { thread_ts: undefined },
    { thread_ts: "200.000001" },
    { thread_ts: "300.000001" },
    { subtype: "thread_broadcast" },
  ]) {
    expect(postReceipt(response(changes), post, identity)).toEqual({
      kind: "misplaced",
      ts: "200.000001",
      metadataOk: true,
    });
  }
});

test("a malformed receipt or a different channel is unverified, never a delete instruction", () => {
  expect(postReceipt(response({}, { ts: undefined }), post, identity)).toEqual({
    kind: "unverified",
    reason: "invalid_response",
  });
  expect(postReceipt(response({ ts: "999.0" }), post, identity)).toEqual({
    kind: "unverified",
    reason: "invalid_response",
  });
  expect(postReceipt(response({ subtype: "tombstone" }), post, identity)).toEqual({
    kind: "unverified",
    reason: "invalid_response",
  });
  expect(postReceipt(response({}, { channel: "COTHER" }), post, identity)).toEqual({
    kind: "unverified",
    reason: "wrong_channel",
  });
  expect(postReceipt(response({ channel: "COTHER" }), post, identity)).toEqual({
    kind: "unverified",
    reason: "wrong_channel",
  });
  expect(postReceipt(response({ bot_id: "BOTHER" }), post, identity)).toEqual({
    kind: "unverified",
    reason: "wrong_author",
  });
});

test("a metadata-drop warning is visible without calling an accepted post a failure", () => {
  for (const receipt of [
    response({ metadata: undefined }),
    response({}, { warning: "invalid_metadata_schema" }),
    response({}, { response_metadata: { warnings: ["invalid_metadata_schema"] } }),
  ]) {
    expect(postReceipt(receipt, post, identity)).toEqual({
      kind: "confirmed",
      ts: "200.000001",
      metadataOk: false,
    });
  }
  expect(postReceipt(response({}, { warning: "missing_charset" }), post, identity)).toMatchObject({
    metadataOk: true,
  });
});

test("an edit's documented receipt need not repeat ts inside message", () => {
  const edit = { ...post, ts: "200.000001" };
  for (const receipt of [
    { ok: true, channel: post.channelId, ts: edit.ts, message: { text: post.text, user: "UBOT" } },
    { ok: true, channel: post.channelId, ts: edit.ts },
  ]) {
    expect(updateReceipt(receipt, edit, identity)).toEqual({
      kind: "confirmed",
      ts: edit.ts,
      metadataOk: false,
    });
  }
});

test("an edit's full echo confirms its metadata without requiring it", () => {
  const edit = { ...post, ts: "200.000001" };
  expect(updateReceipt(response(), edit, identity)).toEqual({
    kind: "confirmed",
    ts: edit.ts,
    metadataOk: true,
  });
  expect(
    updateReceipt(response({}, { warning: "invalid_metadata_schema" }), edit, identity),
  ).toEqual({
    kind: "confirmed",
    ts: edit.ts,
    metadataOk: false,
  });
});

test("an edit receipt must name the exact channel and existing message", () => {
  const edit = { ...post, ts: "200.000001" };
  for (const receipt of [
    response({}, { ts: "300.000001" }),
    response({ ts: "300.000001" }),
    response({}, { ts: undefined }),
    response({}, { ok: false }),
  ]) {
    expect(updateReceipt(receipt, edit, identity)).toEqual({
      kind: "unverified",
      reason: "invalid_response",
    });
  }
  for (const receipt of [response({}, { channel: "COTHER" }), response({ channel: "COTHER" })]) {
    expect(updateReceipt(receipt, edit, identity)).toEqual({
      kind: "unverified",
      reason: "wrong_channel",
    });
  }
});

test("an edit's contradictory author or thread never becomes a delete instruction", () => {
  const edit = { ...post, ts: "200.000001" };
  expect(updateReceipt(response({ bot_id: "BOTHER" }), edit, identity)).toEqual({
    kind: "unverified",
    reason: "wrong_author",
  });
  for (const change of [{ thread_ts: "300.000001" }, { subtype: "tombstone" }]) {
    expect(updateReceipt(response(change), edit, identity)).toEqual({
      kind: "unverified",
      reason: "invalid_response",
    });
  }
});

test("withdrawn content is not receipt or read proof, even with our identity and metadata", () => {
  for (const change of [
    { subtype: "ekm_access_denied" },
    { user: "UREVOKEDU" },
    { hidden: true },
  ]) {
    expect(postReceipt(response(change), post, identity)).toEqual({
      kind: "unverified",
      reason: "invalid_response",
    });
    expect(updateReceipt(response(change), { ...post, ts: "200.000001" }, identity)).toEqual({
      kind: "unverified",
      reason: "invalid_response",
    });
    expect(messageEvidence(message(change), post.channelId, post, identity)).toBeNull();
    expect(messageEvidence(message(change), post.channelId, post, identity, true)).toBeNull();
    expect(reconciliationReceipt(message(change), post.channelId, post, identity)).toBeNull();
  }
});

test("a full matching message proves metadata delivery, even with additive Slack fields", () => {
  expect(messageEvidence(message(), post.channelId, post, identity)).toBe("metadata");
  expect(
    messageEvidence(
      message({ bot_profile: { id: identity.botId, app_id: identity.appId, name: "Bot" } }),
      post.channelId,
      post,
      identity,
    ),
  ).toBe("metadata");
});

test("our app must be identified, and contradictory identities are never evidence", () => {
  for (const changes of [
    { bot_id: undefined },
    { bot_id: "BOTHER" },
    { app_id: undefined },
    { app_id: "AOTHER" },
    { bot_profile: { app_id: "AOTHER" } },
    { bot_profile: { id: "BOTHER" } },
  ]) {
    expect(messageEvidence(message(changes), post.channelId, post, identity, true)).toBeNull();
    expect(reconciliationReceipt(message(changes), post.channelId, post, identity)).toBeNull();
  }
  expect(
    messageEvidence(
      message({ app_id: undefined, bot_profile: { app_id: identity.appId } }),
      post.channelId,
      post,
      identity,
    ),
  ).toBe("metadata");
});

test("the exact channel and thread are required, even for manual verification", () => {
  expect(messageEvidence(message(), "COTHER", post, identity, true)).toBeNull();
  for (const changes of [
    { channel: "COTHER" },
    { thread_ts: undefined },
    { thread_ts: "300.0" },
    { ts: post.threadTs },
    { subtype: "thread_broadcast" },
    { subtype: "tombstone" },
    { subtype: "message_deleted" },
  ]) {
    expect(messageEvidence(message(changes), post.channelId, post, identity, true)).toBeNull();
  }
});

test("a publication is a root, whether or not Slack echoes its own ts as thread_ts", () => {
  const publication = { ...post, threadTs: null };
  for (const thread_ts of [undefined, "200.000001"]) {
    expect(messageEvidence(message({ thread_ts }), post.channelId, publication, identity)).toBe(
      "metadata",
    );
  }
  expect(messageEvidence(message(), post.channelId, publication, identity)).toBeNull();
});

test("partial, wrong or mismatched metadata never permits text fallback", () => {
  for (const metadata of [
    {},
    { event_type: "toy_box_outbox" },
    { ...outboxMetadata(post), event_type: "other_event" },
    outboxMetadata({ ...post, id: "other-item" }),
    outboxMetadata({ ...post, payloadHash: "b".repeat(64) }),
  ]) {
    expect(messageEvidence(message({ metadata }), post.channelId, post, identity, true)).toBeNull();
    expect(reconciliationReceipt(message({ metadata }), post.channelId, post, identity)).toBeNull();
  }
});

test("only explicit manual resolution may use exactly matching text without metadata", () => {
  const candidate = message({ metadata: undefined });
  expect(messageEvidence(candidate, post.channelId, post, identity)).toBeNull();
  expect(reconciliationReceipt(candidate, post.channelId, post, identity)).toBeNull();
  expect(messageEvidence(candidate, post.channelId, post, identity, true)).toBe("text");
  expect(
    messageEvidence(
      message({ metadata: null, text: post.text + "\n" }),
      post.channelId,
      post,
      identity,
      true,
    ),
  ).toBeNull();
});

test("a malformed message is no evidence", () => {
  for (const candidate of [null, {}, message({ ts: "not-a-ts" })]) {
    expect(messageEvidence(candidate, post.channelId, post, identity, true)).toBeNull();
    expect(reconciliationReceipt(candidate, post.channelId, post, identity)).toBeNull();
  }
});

test("automatic reads distinguish a correct post from its correlated misplaced copy", () => {
  expect(reconciliationReceipt(message(), post.channelId, post, identity)).toEqual({
    kind: "confirmed",
    ts: "200.000001",
    metadataOk: true,
  });
  for (const change of [
    { thread_ts: undefined },
    { thread_ts: "300.1" },
    { subtype: "thread_broadcast" },
  ]) {
    expect(reconciliationReceipt(message(change), post.channelId, post, identity)).toEqual({
      kind: "misplaced",
      ts: "200.000001",
      metadataOk: true,
    });
  }
  expect(reconciliationReceipt(message(), "C-other", post, identity)).toBeNull();
  expect(
    reconciliationReceipt(message({ channel: "C-other" }), post.channelId, post, identity),
  ).toBeNull();
});

test("an edit read proves only its existing target and never authorizes misplaced cleanup", () => {
  const edit = { ...post, ts: "200.000001" };
  expect(reconciliationReceipt(message(), post.channelId, edit, identity)).toMatchObject({
    kind: "confirmed",
  });
  for (const change of [
    { ts: "200.000002" },
    { thread_ts: undefined },
    { thread_ts: "300.1" },
    { subtype: "thread_broadcast" },
  ]) {
    expect(reconciliationReceipt(message(change), post.channelId, edit, identity)).toBeNull();
  }
});

test("reconciliation has three exact deadlines, then stops without permitting resend", () => {
  expect(nextReconciliation(1_000, 0)).toBe(11_000);
  expect(nextReconciliation(1_000, 1)).toBe(61_000);
  expect(nextReconciliation(1_000, 2)).toBe(121_000);
  expect(nextReconciliation(1_000, 3)).toBeNull();
  for (const invalid of [-1, 0.5, 4, Number.NaN]) {
    expect(() => nextReconciliation(0, invalid)).toThrow(RangeError);
  }
  expect(() => nextReconciliation(-1, 0)).toThrow(RangeError);
});

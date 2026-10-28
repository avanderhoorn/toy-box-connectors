import { describe, expect, test } from "bun:test";
import type { RequestState } from "@requests/model/lifecycle";
import {
  isCancelReason,
  REASON_LIMIT,
  reasonSchema,
  requestEnding,
  requestReferenceSchema,
  requestStateProblem,
  revisionProblem,
} from "./requests";

describe("naming a request", () => {
  test("reads the number inbox shows after r", () => {
    expect(requestReferenceSchema.parse("r14")).toBe(14);
    expect(requestReferenceSchema.parse("r999999999999999")).toBe(999_999_999_999_999);
  });

  test.each(["14", "R14", "r0", "r014", "r14 ", " r14", "r1e3", "r1234567890123456", "a4"])(
    "refuses %p, saying how to write it",
    (reference) => {
      const parsed = requestReferenceSchema.safeParse(reference);
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
        "Write it as inbox shows it, such as r14",
      ]);
    },
  );
});

describe("a reason", () => {
  test("is kept without the space around it", () => {
    expect(reasonSchema.parse("  waiting on Alice\n")).toBe("waiting on Alice");
    expect(reasonSchema.parse("x".repeat(REASON_LIMIT))).toHaveLength(REASON_LIMIT);
  });

  test.each([
    ["", "Can't be blank"],
    [" \n ", "Can't be blank"],
    ["x".repeat(REASON_LIMIT + 1), "Keep it within 200 characters"],
  ])("refuses %p", (reason, message) => {
    expect(reasonSchema.safeParse(reason).error?.issues.map((issue) => issue.message)).toEqual([
      message,
    ]);
  });
});

describe("whether the lead can act on a request", () => {
  const request = (state: RequestState, closedReason: string | null = null) => ({
    id: 14,
    state,
    closedReason,
  });

  test.each(["seen", "in_progress"] as const)("it can once it's read and %s", (state) => {
    expect(requestStateProblem(request(state))).toBeNull();
  });

  test.each([
    [
      "open",
      null,
      "unread_request",
      "You haven't read r14 yet. Run `toy-box-slack thread r14` to read it.",
    ],
    [
      "answering",
      null,
      "answering_request",
      "Your reply to r14 is on its way to Slack. If it doesn't post, the next inbox shows r14 again.",
    ],
    ["answered", null, "closed_request", "r14 was already answered."],
    ["dismissed", "a duplicate of r12", "closed_request", "r14 was already dismissed."],
    [
      "cancelled",
      "source_deleted",
      "closed_request",
      "r14 was cancelled because the message was deleted in Slack. Don't repeat what it said.",
    ],
    [
      "cancelled",
      "requester_denied",
      "closed_request",
      "r14 was cancelled because the person who asked is no longer allowed.",
    ],
    ["expired", null, "closed_request", "r14 expired after 7 days without an answer."],
  ] as const)("it can't while %s", (state, closedReason, rule, message) => {
    expect(requestStateProblem(request(state, closedReason))).toEqual({ rule, message });
  });
});

describe("how a request ended", () => {
  test.each([
    ["source_deleted", "cancelled because the message was deleted in Slack"],
    ["mention_removed", "cancelled because the message no longer mentions you"],
    ["requester_denied", "cancelled because the person who asked is no longer allowed"],
    ["link_removed", "cancelled because this channel was unlinked from Slack"],
    ["channel_deleted", "cancelled because its Slack channel was deleted"],
    ["thread_gone", "cancelled because Slack could not deliver to its thread"],
    [null, "cancelled"],
    ["constructor", "cancelled"],
  ])("cancelled for %p reads as why", (closedReason, clause) => {
    expect(requestEnding({ state: "cancelled", closedReason }).clause).toBe(clause);
  });

  test("tells why the bridge cancelled a request from why the lead dismissed one", () => {
    expect(isCancelReason("requester_denied")).toBe(true);
    for (const reason of [null, "answered in standup", "constructor"]) {
      expect(isCancelReason(reason)).toBe(false);
    }
  });

  test("only a deleted message cautions against repeating it", () => {
    expect(requestEnding({ state: "cancelled", closedReason: "source_deleted" }).caution).toBe(
      "Don't repeat what it said.",
    );
    expect(requestEnding({ state: "cancelled", closedReason: "mention_removed" }).caution).toBe(
      null,
    );
  });

  test("expiring says how long it waited", () => {
    expect(requestEnding({ state: "expired", closedReason: null })).toEqual({
      clause: "expired after 7 days without an answer",
      caution: null,
    });
  });
});

describe("the revision the lead quotes", () => {
  const request = { id: 14, inputRev: 2 };

  test("must be the request's latest", () => {
    expect(revisionProblem(request, 2)).toBeNull();
  });

  test("an older one names the revision to read", () => {
    expect(revisionProblem(request, 1)).toEqual({
      rule: "stale_revision",
      message:
        "r14 changed since you read revision 1. Run `toy-box-slack thread r14` to read revision 2.",
    });
  });

  test("a newer one says which is latest", () => {
    expect(revisionProblem(request, 3)).toEqual({
      rule: "unknown_revision",
      message:
        "r14 has no revision 3. Its latest is revision 2, which `toy-box-slack thread r14` shows.",
    });
  });
});

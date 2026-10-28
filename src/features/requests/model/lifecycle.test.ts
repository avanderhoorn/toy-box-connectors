import { describe, expect, test } from "bun:test";
import {
  beginAnswer,
  cancelRequest,
  canMove,
  confirmAnswer,
  dismissRequest,
  expireRequest,
  inputSource,
  isActive,
  isDueToExpire,
  holdRequest,
  openRequest,
  releaseHold,
  requestLifetimeMs,
  RequestStateError,
  requestStates,
  returnToProgress,
  reviseRequest,
  serveRequest,
  startProgress,
  type Request,
  type RequestState,
} from "./lifecycle";

const openedAt = 1_700_000_000_000;
const later = openedAt + 60_000;

const opened = openRequest(
  {
    linkId: "link",
    channelId: "C1",
    rootTs: "1700000000.000100",
    sourceTs: "1700000000.000100",
    requesterUserId: "UALICE",
    reason: "mention",
    inputHash: "hash-1",
    late: false,
  },
  openedAt,
);

function inState(state: RequestState, changes: Partial<Request> = {}): Request {
  const seenAt = state === "open" ? null : openedAt + 1_000;
  return { ...opened, state, seenAt, ...changes };
}

const moves: Record<RequestState, RequestState[]> = {
  open: ["seen", "cancelled", "expired"],
  seen: ["in_progress", "answering", "dismissed", "cancelled", "expired"],
  in_progress: ["answering", "dismissed", "cancelled", "expired"],
  answering: ["answered", "in_progress", "cancelled"],
  answered: [],
  dismissed: [],
  cancelled: [],
  expired: [],
};

describe("the request state machine", () => {
  test("allows exactly the moves the lifecycle names", () => {
    for (const from of requestStates) {
      for (const to of requestStates) {
        expect(`${from}->${to}:${canMove(from, to)}`).toBe(
          `${from}->${to}:${moves[from].includes(to)}`,
        );
      }
    }
  });

  test("answered, dismissed, cancelled and expired requests are closed for good", () => {
    expect(requestStates.filter((state) => isActive(state))).toEqual([
      "open",
      "seen",
      "in_progress",
      "answering",
    ]);
  });
});

describe("opening", () => {
  test("a request opens unseen at revision 1 and expires after its lifetime", () => {
    expect(opened).toMatchObject({
      state: "open",
      inputRev: 1,
      inputHash: "hash-1",
      servedRev: 0,
      attention: null,
      sourceUnverifiedAt: null,
      heldAt: null,
      createdAt: openedAt,
      changedAt: openedAt,
      seenAt: null,
      touchedAt: null,
      expiresAt: openedAt + 7 * 24 * 60 * 60_000,
      closedReason: null,
    });
    expect(requestLifetimeMs).toBe(604_800_000);
  });
});

describe("serving", () => {
  test("showing an open request to the lead marks it seen at its current revision", () => {
    const shown = serveRequest({ ...opened, inputRev: 2 }, later);
    expect(shown).toMatchObject({ state: "seen", seenAt: later, touchedAt: later, servedRev: 2 });
  });

  test("showing a request again records the read without moving it", () => {
    const working = inState("in_progress", { inputRev: 3, servedRev: 1, attention: "updated" });
    expect(serveRequest(working, later)).toEqual({
      ...working,
      servedRev: 3,
      touchedAt: later,
      attention: null,
    });
  });

  test("the read answers a failed reply and leaves an unverified source to repair", () => {
    const failed = inState("in_progress", { attention: "reply_failed", sourceUnverifiedAt: later });
    expect(serveRequest(failed, later + 1)).toEqual({
      ...failed,
      servedRev: 1,
      touchedAt: later + 1,
      attention: null,
    });
  });
});

describe("progress and answers", () => {
  test("progress moves a seen request to in progress, and more progress keeps it there", () => {
    const working = startProgress(inState("seen"), later);
    expect(working).toMatchObject({ state: "in_progress", touchedAt: later });
    expect(startProgress(working, later + 1)).toEqual({ ...working, touchedAt: later + 1 });
  });

  test("progress needs a request the lead has read and hasn't answered", () => {
    for (const state of ["open", "answering", "answered", "dismissed"] as const) {
      expect(() => startProgress(inState(state), later)).toThrow(
        "A request that's " + state + " can't start progress.",
      );
    }
  });

  test("queueing a final reply moves a seen or in-progress request to answering and ends its hold", () => {
    for (const state of ["seen", "in_progress"] as const) {
      const held = inState(state, { heldAt: later, holdReason: "asking", attention: "updated" });
      expect(beginAnswer(held, later + 1)).toMatchObject({
        state: "answering",
        heldAt: null,
        holdReason: null,
        attention: null,
        touchedAt: later + 1,
      });
    }
  });

  test("a final reply can be queued while the source is unverified, and waits for repair", () => {
    const unverified = inState("seen", { sourceUnverifiedAt: later });
    expect(beginAnswer(unverified, later + 1)).toEqual({
      ...unverified,
      state: "answering",
      touchedAt: later + 1,
    });
  });

  test("a final reply to a newer revision keeps an answering request answering", () => {
    const answering = inState("answering", { inputRev: 2, attention: "updated" });
    expect(beginAnswer(answering, later)).toEqual({
      ...answering,
      attention: null,
      touchedAt: later,
    });
  });

  test("a final reply needs a request the lead has read and that's still active", () => {
    for (const state of ["open", "answered", "dismissed", "cancelled", "expired"] as const) {
      expect(() => beginAnswer(inState(state), later)).toThrow(RequestStateError);
    }
  });

  test("Slack confirming the reply to the current revision answers the request", () => {
    const answering = inState("answering", {
      inputRev: 2,
      attention: "updated",
      sourceUnverifiedAt: later,
    });
    expect(confirmAnswer(answering, 2, later)).toEqual({
      ...answering,
      state: "answered",
      attention: null,
      sourceUnverifiedAt: null,
    });
  });

  test("a confirmed reply to an older revision sends the request back as updated", () => {
    const answering = inState("answering", { inputRev: 2 });
    expect(confirmAnswer(answering, 1, later)).toEqual({
      ...answering,
      state: "in_progress",
      attention: "updated",
      changedAt: later,
    });
  });

  test("a confirmed reply can't name a revision the request hasn't reached", () => {
    expect(() => confirmAnswer(inState("answering"), 2, later)).toThrow(RangeError);
  });

  test("only an answering request can be answered", () => {
    for (const state of ["seen", "in_progress", "cancelled"] as const) {
      expect(() => confirmAnswer(inState(state), 1, later)).toThrow(RequestStateError);
    }
  });

  test("a failed or dropped reply sends the request back to the lead", () => {
    const answering = inState("answering");
    expect(returnToProgress(answering, "reply_failed", later)).toEqual({
      ...answering,
      state: "in_progress",
      attention: "reply_failed",
      changedAt: later,
    });
    const unverified = inState("answering", { attention: "updated", sourceUnverifiedAt: later });
    expect(returnToProgress(unverified, "reply_failed", later + 1)).toEqual({
      ...unverified,
      state: "in_progress",
      attention: "reply_failed",
      changedAt: later + 1,
    });
    for (const state of ["seen", "in_progress", "cancelled"] as const) {
      expect(() => returnToProgress(inState(state), "reply_failed", later)).toThrow(
        "A request that's " + state.replace("_", " ") + " can't return to progress.",
      );
    }
  });
});

describe("closing", () => {
  test("the lead can dismiss a request it has read but not one it's answering", () => {
    for (const state of ["seen", "in_progress"] as const) {
      const held = inState(state, {
        heldAt: later,
        holdReason: "asking",
        attention: "updated",
        sourceUnverifiedAt: later,
      });
      expect(dismissRequest(held, "answered in standup")).toEqual({
        ...held,
        state: "dismissed",
        closedReason: "answered in standup",
        attention: null,
        sourceUnverifiedAt: null,
        heldAt: null,
        holdReason: null,
      });
    }
    for (const state of ["open", "answering", "answered", "expired"] as const) {
      expect(() => dismissRequest(inState(state), "no")).toThrow(RequestStateError);
    }
  });

  test("any active request can be cancelled, even one answering", () => {
    for (const state of ["open", "seen", "in_progress", "answering"] as const) {
      const attention = state === "open" ? null : "updated";
      const active = inState(state, { attention, sourceUnverifiedAt: later });
      expect(cancelRequest(active, "source_deleted")).toMatchObject({
        state: "cancelled",
        closedReason: "source_deleted",
        attention: null,
        sourceUnverifiedAt: null,
      });
    }
    for (const state of ["answered", "dismissed", "cancelled", "expired"] as const) {
      expect(() => cancelRequest(inState(state), "mention_removed")).toThrow(
        "A request that's " + state + " can't become cancelled.",
      );
    }
  });

  test("a request expires once its lifetime passes, unless it's answering", () => {
    const due = opened.expiresAt;
    expect(isDueToExpire(inState("in_progress"), due - 1)).toBe(false);
    for (const state of ["open", "seen", "in_progress"] as const) {
      expect(isDueToExpire(inState(state), due)).toBe(true);
      const held = inState(state, {
        heldAt: later,
        holdReason: "asking",
        sourceUnverifiedAt: later,
      });
      expect(expireRequest(held, due)).toEqual({
        ...held,
        state: "expired",
        closedReason: null,
        attention: null,
        sourceUnverifiedAt: null,
        heldAt: null,
        holdReason: null,
      });
    }
    expect(isDueToExpire(inState("answering"), due)).toBe(false);
    expect(isDueToExpire(inState("answered"), due)).toBe(false);
    expect(() => expireRequest(inState("answering"), due)).toThrow(RequestStateError);
  });

  test("a request can't expire early", () => {
    expect(() => expireRequest(inState("seen"), opened.expiresAt - 1)).toThrow(RangeError);
  });
});

describe("holds", () => {
  test("the lead can hold a request it has read, and holding again replaces the reason", () => {
    const held = holdRequest(inState("seen"), "asking the owner", later);
    expect(held).toMatchObject({ heldAt: later, holdReason: "asking the owner", touchedAt: later });
    expect(holdRequest(held, "still asking", later + 1)).toMatchObject({
      state: "seen",
      heldAt: later + 1,
      holdReason: "still asking",
    });
    expect(holdRequest(inState("in_progress"), "asking", later).heldAt).toBe(later);
  });

  test("an unread, answering or closed request can't be held", () => {
    for (const state of ["open", "answering", "answered", "expired"] as const) {
      expect(() => holdRequest(inState(state), "asking", later)).toThrow(
        "A request that's " + state + " can't be held.",
      );
    }
  });

  test("releasing a hold clears it", () => {
    const held = holdRequest(inState("in_progress"), "asking", later);
    expect(releaseHold(held)).toEqual({ ...held, heldAt: null, holdReason: null });
  });
});

describe("revisions", () => {
  test("new input bumps the revision, flags a request the lead has seen, and ends its hold", () => {
    for (const state of ["seen", "in_progress", "answering"] as const) {
      const held = inState(state, { heldAt: later, holdReason: "asking" });
      expect(reviseRequest(held, "hash-2", later + 1)).toEqual({
        ...held,
        inputRev: 2,
        inputHash: "hash-2",
        changedAt: later + 1,
        attention: "updated",
        heldAt: null,
        holdReason: null,
      });
    }
  });

  test("an open request takes new input without being flagged, since the lead hasn't read it", () => {
    expect(reviseRequest(opened, "hash-2", later)).toMatchObject({
      inputRev: 2,
      attention: null,
      changedAt: later,
    });
  });

  test("new input leaves a failed reply flagged and the source unverified", () => {
    const failed = inState("in_progress", { attention: "reply_failed", sourceUnverifiedAt: later });
    expect(reviseRequest(failed, "hash-2", later + 1)).toEqual({
      ...failed,
      inputRev: 2,
      inputHash: "hash-2",
      changedAt: later + 1,
    });
  });

  test("input that hashes the same changes nothing", () => {
    const seen = inState("seen", { heldAt: later, holdReason: "asking" });
    expect(reviseRequest(seen, "hash-1", later + 1)).toBe(seen);
  });

  test("a closed request takes no new input", () => {
    for (const state of ["answered", "dismissed", "cancelled", "expired"] as const) {
      expect(() => reviseRequest(inState(state), "hash-2", later)).toThrow(RequestStateError);
    }
  });

  test("a request's input is its messages that still exist, in ts order", () => {
    const first = { ts: "1700000000.000100", deleted: false, contentHash: "a" };
    const second = { ts: "999999999.000100", deleted: false, contentHash: "b" };
    const gone = { ts: "1700000005.000100", deleted: true, contentHash: null };
    expect(inputSource([first, gone, second])).toBe(
      JSON.stringify([
        ["999999999.000100", "b"],
        ["1700000000.000100", "a"],
      ]),
    );
    expect(inputSource([first, second])).toBe(inputSource([second, first]));
    expect(inputSource([first, { ...second, contentHash: "c" }])).not.toBe(
      inputSource([first, second]),
    );
  });
});

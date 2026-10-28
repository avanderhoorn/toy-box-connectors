import { describe, expect, test } from "bun:test";
import type { SlackMessage } from "@slackapi/model/messages";
import {
  admitPoster,
  answerClaim,
  attemptClaim,
  CLAIM_CODE_SPACE,
  CLAIM_LIFETIME_MS,
  claimAttempt,
  claimStatus,
  formatClaimCode,
  hashClaimCode,
  isOpen,
  newClaim,
  readClaim,
  voidClaim,
} from "./claim";

describe("reading claims", () => {
  test("the mention, claim and a code is an exact claim", () => {
    expect(readClaim("<@UBOT> claim 4829-1734", "UBOT")).toEqual({ code: "4829-1734" });
    expect(readClaim("  <@UBOT|toy-box>  CLAIM\t4829-1734 \n", "UBOT")).toEqual({
      code: "4829-1734",
    });
  });

  test("anything else after our mention and the word claim is consumed without a code", () => {
    expect(readClaim("<@UBOT> claim 4829-1734 please", "UBOT")).toEqual({ code: null });
    expect(readClaim("<@UBOT> claim: 4829-1734", "UBOT")).toEqual({ code: null });
    expect(readClaim("<@UBOT> claim", "UBOT")).toEqual({ code: null });
    expect(readClaim("<@UBOT>claim 4829-1734", "UBOT")).toEqual({ code: "4829-1734" });
  });

  test("a message that doesn't start with our mention and the word claim isn't a claim", () => {
    expect(readClaim("<@UOTHER> claim 4829-1734", "UBOT")).toBeNull();
    expect(readClaim("hey <@UBOT> claim 4829-1734", "UBOT")).toBeNull();
    expect(readClaim("<@UBOT> claims are due friday", "UBOT")).toBeNull();
    expect(readClaim("<@UBOT> what's a claim?", "UBOT")).toBeNull();
    expect(readClaim("claim 4829-1734", "UBOT")).toBeNull();
  });
});

describe("claim attempts", () => {
  const exact = { code: "4829-1734" };
  const message: SlackMessage = {
    channelId: "CPRIVATE",
    ts: "1700000000.000100",
    threadTs: null,
    rootTs: "1700000000.000100",
    isReply: false,
    userId: "UALICE",
    teamId: "THOME",
    subtype: null,
    author: "person",
    text: "<@UBOT> claim 4829-1734",
    files: [],
    mentions: ["UBOT"],
    mentionsBot: true,
    editedTs: null,
    version: "1700000000.000100",
    latestReplyTs: null,
  };

  const posted = { claim: exact, message, edit: false, late: false };

  test("a person posting the exact shape live and new makes an attempt", () => {
    const attempt = { code: "4829-1734", userId: "UALICE", channelId: "CPRIVATE", ts: message.ts };
    expect(claimAttempt(posted)).toEqual(attempt);
    expect(claimAttempt({ ...posted, message: { ...message, isReply: true } })).toEqual(attempt);
  });

  test("the workspace a message names for its author doesn't matter, because admission decides", () => {
    expect(claimAttempt({ ...posted, message: { ...message, teamId: "TSIBLING" } })).not.toBeNull();
    expect(claimAttempt({ ...posted, message: { ...message, teamId: null } })).not.toBeNull();
  });

  test("edits, backfilled posts, broadcasts, file shares and anyone but a person never make an attempt", () => {
    expect(claimAttempt({ ...posted, claim: { code: null } })).toBeNull();
    expect(claimAttempt({ ...posted, edit: true })).toBeNull();
    expect(claimAttempt({ ...posted, late: true })).toBeNull();
    for (const subtype of ["thread_broadcast", "file_share"]) {
      expect(claimAttempt({ ...posted, message: { ...message, subtype } })).toBeNull();
    }
    for (const author of ["self", "bot", "notice"] as const) {
      expect(claimAttempt({ ...posted, message: { ...message, author } })).toBeNull();
    }
    expect(claimAttempt({ ...posted, message: { ...message, userId: null } })).toBeNull();
  });
});

describe("claim codes", () => {
  test("a code is eight digits in two groups of four", () => {
    expect(formatClaimCode(48_291_734)).toBe("4829-1734");
    expect(formatClaimCode(0)).toBe("0000-0000");
    expect(formatClaimCode(CLAIM_CODE_SPACE - 1)).toBe("9999-9999");
  });

  test("only an integer below 10⁸ names a code", () => {
    for (const value of [-1, CLAIM_CODE_SPACE, 1.5, Number.NaN]) {
      expect(() => formatClaimCode(value)).toThrow(RangeError);
    }
  });

  test("a code is kept as a hash that ignores its hyphens", () => {
    const hash = hashClaimCode("4829-1734");
    expect(hash).not.toContain("4829");
    expect(hashClaimCode("48291734")).toBe(hash);
    expect(hashClaimCode("4829-1735")).not.toBe(hash);
  });
});

describe("attempting a claim", () => {
  const live = newClaim(hashClaimCode("4829-1734"), 0);
  const attempt = { code: "4829-1734", userId: "UALICE", channelId: "CPRIVATE", ts: "600.000100" };

  test("the right code posts the claim, recording who posted it, where and when", () => {
    expect(attemptClaim(live, attempt, 60_000)).toEqual({
      outcome: "posted",
      claim: {
        ...live,
        state: "posted",
        post: { userId: "UALICE", channelId: "CPRIVATE", ts: "600.000100", at: 60_000 },
      },
    });
    expect(attemptClaim(live, { ...attempt, code: "48291734" }, 60_000)?.outcome).toBe("posted");
  });

  test("a wrong code counts against the claim", () => {
    expect(attemptClaim(live, { ...attempt, code: "4829-1735" }, 60_000)).toEqual({
      outcome: "missed",
      claim: { ...live, failedAttempts: 1 },
    });
    expect(attemptClaim(live, { ...attempt, code: "hello" }, 60_000)?.outcome).toBe("missed");
  });

  test("the fifth wrong code voids the claim, so a sixth can't be tried", () => {
    let claim = live;
    for (let tries = 1; tries < 5; tries += 1) {
      claim = attemptClaim(claim, { ...attempt, code: `0000-000${tries}` }, tries)!.claim;
      expect(claim).toMatchObject({ state: "live", failedAttempts: tries });
    }
    expect(attemptClaim(claim, { ...attempt, code: "0000-0009" }, 9)).toEqual({
      outcome: "exhausted",
      claim: {
        ...claim,
        state: "void",
        failedAttempts: 5,
        decidedAt: 9,
        voidReason: "exhausted",
      },
    });
    const exhausted = attemptClaim(claim, { ...attempt, code: "0000-0009" }, 9)!.claim;
    expect(attemptClaim(exhausted, attempt, 10)).toBeNull();
  });

  test("an attempt ten minutes after the code was made voids the claim without trying the code", () => {
    expect(attemptClaim(live, attempt, 10 * 60_000)).toEqual({
      outcome: "expired",
      claim: { ...live, state: "void", decidedAt: 10 * 60_000, voidReason: "expired" },
    });
    expect(attemptClaim(live, attempt, 10 * 60_000 - 1)?.outcome).toBe("posted");
  });

  test("a code works once, so nobody can take over a posted claim", () => {
    const posted = attemptClaim(live, attempt, 60_000)!.claim;
    expect(attemptClaim(posted, { ...attempt, userId: "UMALLORY" }, 61_000)).toBeNull();
    expect(attemptClaim(posted, { ...attempt, code: "0000-0000" }, 61_000)).toBeNull();
  });

  test("a closed claim takes no attempts", () => {
    for (const state of ["confirmed", "declined", "void"] as const) {
      expect(attemptClaim({ ...live, state, decidedAt: 1 }, attempt, 60_000)).toBeNull();
    }
  });
});

describe("admitting who posted the code", () => {
  const live = newClaim(hashClaimCode("4829-1734"), 0);
  const posted = attemptClaim(
    live,
    { code: "4829-1734", userId: "UALICE", channelId: "CPRIVATE", ts: "600.000100" },
    60_000,
  )!.claim;

  test("someone the admission check passes can be asked about", () => {
    expect(admitPoster(posted, null, 70_000)).toEqual({ ...posted, state: "admitted" });
  });

  test("someone it refuses voids the code for that reason, keeping who posted it", () => {
    expect(admitPoster(posted, "guest", 70_000)).toEqual({
      ...posted,
      state: "void",
      decidedAt: 70_000,
      voidReason: "guest",
    });
  });

  test("past the deadline the claim is void instead", () => {
    expect(admitPoster(posted, null, CLAIM_LIFETIME_MS)).toEqual({
      ...posted,
      state: "void",
      decidedAt: CLAIM_LIFETIME_MS,
      voidReason: "expired",
    });
  });

  test("only a posted claim waits to be admitted", () => {
    expect(admitPoster(live, null, 70_000)).toBeNull();
    const admitted = admitPoster(posted, null, 70_000)!;
    expect(admitPoster(admitted, "guest", 71_000)).toBeNull();
    for (const state of ["confirmed", "declined", "void"] as const) {
      expect(admitPoster({ ...posted, state, decidedAt: 1 }, null, 70_000)).toBeNull();
    }
  });
});

describe("answering a claim", () => {
  const live = newClaim(hashClaimCode("4829-1734"), 0);
  const posted = attemptClaim(
    live,
    { code: "4829-1734", userId: "UALICE", channelId: "CPRIVATE", ts: "600.000100" },
    60_000,
  )!.claim;
  const admitted = admitPoster(posted, null, 70_000)!;
  const yes = { confirm: true, postedBy: "UALICE" };

  test("yes confirms the person the terminal showed, once a fresh check admits them again", () => {
    expect(answerClaim(admitted, yes, null, 90_000)).toEqual({
      kind: "confirmed",
      claim: { ...admitted, state: "confirmed", decidedAt: 90_000 },
    });
  });

  test("yes for someone the fresh check refuses voids the claim for that reason instead", () => {
    expect(answerClaim(admitted, yes, "deactivated", 90_000)).toEqual({
      kind: "void",
      claim: { ...admitted, state: "void", decidedAt: 90_000, voidReason: "deactivated" },
    });
  });

  test("no declines the claim and keeps who posted it, whatever the check says", () => {
    for (const problem of [null, "guest"] as const) {
      expect(answerClaim(admitted, { ...yes, confirm: false }, problem, 90_000)).toEqual({
        kind: "declined",
        claim: { ...admitted, state: "declined", decidedAt: 90_000 },
      });
    }
  });

  test("an answer after the deadline voids the claim instead", () => {
    expect(answerClaim(admitted, yes, null, CLAIM_LIFETIME_MS)).toEqual({
      kind: "void",
      claim: { ...admitted, state: "void", decidedAt: CLAIM_LIFETIME_MS, voidReason: "expired" },
    });
  });

  test("an answer about someone else changes nothing", () => {
    expect(answerClaim(admitted, { ...yes, postedBy: "UMALLORY" }, null, 90_000)).toEqual({
      kind: "refused",
      reason: "different_poster",
    });
  });

  test("only an admitted claim takes an answer", () => {
    expect(answerClaim(live, yes, null, 90_000)).toEqual({
      kind: "refused",
      reason: "not_posted",
    });
    expect(answerClaim(posted, yes, null, 90_000)).toEqual({
      kind: "refused",
      reason: "not_admitted",
    });
    for (const state of ["confirmed", "declined", "void"] as const) {
      expect(answerClaim({ ...admitted, state, decidedAt: 1 }, yes, null, 90_000)).toEqual({
        kind: "refused",
        reason: "closed",
      });
    }
  });
});

describe("claim status", () => {
  const live = newClaim(hashClaimCode("4829-1734"), 0);

  test("an open claim past its deadline reads as expired before anything records it", () => {
    expect(claimStatus(live, CLAIM_LIFETIME_MS - 1)).toBe("live");
    expect(claimStatus(live, CLAIM_LIFETIME_MS)).toBe("expired");
    expect(claimStatus({ ...live, state: "posted" }, CLAIM_LIFETIME_MS)).toBe("expired");
    expect(claimStatus({ ...live, state: "admitted" }, CLAIM_LIFETIME_MS)).toBe("expired");
    expect(claimStatus({ ...live, state: "confirmed" }, CLAIM_LIFETIME_MS)).toBe("confirmed");
  });

  test("voiding closes only an open claim, saying why", () => {
    expect(voidClaim(live, "replaced", 5)).toEqual({
      ...live,
      state: "void",
      decidedAt: 5,
      voidReason: "replaced",
    });
    expect(isOpen(voidClaim(live, "replaced", 5))).toBe(false);
    expect(() => voidClaim({ ...live, state: "declined", decidedAt: 1 }, "replaced", 5)).toThrow(
      RangeError,
    );
  });
});

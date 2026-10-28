import { describe, expect, test } from "bun:test";
import type { SlackMessage } from "@slackapi/model/messages";
import { isClaimAttempt, readClaim } from "./claim";

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

  test("a person in our team posting the exact shape live and new makes an attempt", () => {
    expect(isClaimAttempt(exact, message, false, "THOME")).toBe(true);
    expect(isClaimAttempt(exact, { ...message, isReply: true }, false, "THOME")).toBe(true);
  });

  test("edits, broadcasts, other authors and other teams never make an attempt", () => {
    expect(isClaimAttempt({ code: null }, message, false, "THOME")).toBe(false);
    expect(isClaimAttempt(exact, message, true, "THOME")).toBe(false);
    expect(isClaimAttempt(exact, { ...message, subtype: "thread_broadcast" }, false, "THOME")).toBe(
      false,
    );
    expect(isClaimAttempt(exact, { ...message, subtype: "file_share" }, false, "THOME")).toBe(
      false,
    );
    for (const author of ["self", "bot", "notice"] as const) {
      expect(isClaimAttempt(exact, { ...message, author }, false, "THOME")).toBe(false);
    }
    expect(isClaimAttempt(exact, { ...message, teamId: "TGUEST" }, false, "THOME")).toBe(false);
  });
});

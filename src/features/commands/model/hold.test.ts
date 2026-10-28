import { describe, expect, test } from "bun:test";
import { checkCommandInput } from "./commandLine";
import { holdContract, presentHold, type HoldResult } from "./hold";

const AT = 1_700_002_000_000;
const DAY = 24 * 60 * 60_000;

const held: HoldResult = { request: 14, attention: null, expiresAt: AT + 6 * DAY };

describe("holding a request", () => {
  test("takes the request as inbox shows it and the reason without its spaces", () => {
    expect(
      checkCommandInput("hold", holdContract, { request: "r14", reason: "  Ship Friday?  " }),
    ).toEqual({ kind: "checked", input: { request: 14, reason: "Ship Friday?" } });
    expect(checkCommandInput("hold", holdContract, { request: "14", reason: "x" })).toEqual({
      kind: "refused",
      message:
        "<request>: Write it as inbox shows it, such as r14. Run `toy-box-slack hold --help`.",
    });
    expect(checkCommandInput("hold", holdContract, { request: "r14" })).toMatchObject({
      message: "`hold` needs --reason. Run `toy-box-slack hold --help`.",
    });
  });

  test("says when the hold ends and that the request still expires", () => {
    expect(presentHold(held, { at: AT })).toBe(
      "Held r14, so you won't be reminded about it. The hold ends when the owner next posts in this Toy Box channel or r14 changes in Slack. It still expires in 6 days.",
    );
  });

  test("says what the lead still owes a request that needs another look", () => {
    const notes = (attention: HoldResult["attention"]) =>
      presentHold({ ...held, attention }, { at: AT })
        .split("\n\n")
        .slice(1);

    expect(notes("updated")).toEqual([
      "r14 changed since you last read it. Run `toy-box-slack thread r14` to read it.",
    ]);
    expect(notes("reply_failed")).toEqual([
      "Your last reply to r14 didn't post, so answer it again once the owner decides.",
    ]);
  });
});

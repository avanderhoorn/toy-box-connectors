import { expect, test } from "bun:test";
import { checkCommandInput } from "./commandLine";
import { dismissContract, presentDismiss } from "./dismiss";

test("dismissing a request takes the revision the lead read and says nothing posts", () => {
  expect(
    checkCommandInput("dismiss", dismissContract, {
      request: "r14",
      revision: 2,
      reason: "Duplicate of r12",
    }),
  ).toEqual({ kind: "checked", input: { request: 14, revision: 2, reason: "Duplicate of r12" } });
  expect(
    checkCommandInput("dismiss", dismissContract, { request: "r14", reason: "Duplicate" }),
  ).toMatchObject({
    message: "`dismiss` needs --revision. Run `toy-box-slack dismiss --help`.",
  });
  expect(presentDismiss({ request: 14 })).toBe("Dismissed r14 without replying in Slack.");
});

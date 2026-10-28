import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { slackConnectionSchema } from "./banner";
import type { CallerRole } from "./callers";
import { commandContract, type CommandContract } from "./contract";
import { isSlackUsable, refuseWithoutSlack } from "./withoutSlack";

function command(
  roles: readonly CallerRole[],
  options: Pick<CommandContract, "withoutSlack" | "step"> = {},
) {
  return commandContract({
    description: "A command",
    roles,
    scope: "bridge",
    ...options,
    input: z.object({}).strict(),
    result: z.object({}).strict(),
    present: () => "",
  });
}

const contracts = {
  status: command(["lead", "member", "operator"], { withoutSlack: true }),
  reply: command(["lead"]),
  doctor: command(["operator"], { withoutSlack: true }),
  pause: command(["lead", "operator"], { withoutSlack: true }),
  wait: command(["operator"], { withoutSlack: true, step: true }),
};

const rejected = {
  connection: "auth_failed",
  problem: "Slack rejects SLACK_BOT_TOKEN. Put a working one in credentials.env.",
} as const;

describe("isSlackUsable", () => {
  test("holds from the first hello in a run, through any reconnect", () => {
    expect(slackConnectionSchema.options.filter(isSlackUsable)).toEqual([
      "connected",
      "reconnecting",
    ]);
  });
});

describe("refuseWithoutSlack", () => {
  test("says what's wrong and how to fix it, then what still runs", () => {
    expect(refuseWithoutSlack("`reply`", rejected, contracts, "lead")).toEqual({
      rule: "slack_unavailable",
      message:
        "`reply` needs Slack, which the bridge can't use right now. Slack rejects SLACK_BOT_TOKEN. Put a working one in credentials.env. Until then it runs only `status` and `pause`.",
    });
  });

  test("asks the caller to try again only while Slack is still connecting, unless something's wrong", () => {
    const refusal = (connection: "connecting" | "refused", problem: string | null) =>
      refuseWithoutSlack("`reply`", { connection, problem }, contracts, "lead").message;

    expect(refusal("connecting", null)).toBe(
      "`reply` needs Slack, which the bridge can't use right now. It's still connecting to Slack, so try again in a minute. Until then it runs only `status` and `pause`.",
    );
    expect(refusal("connecting", "Slack didn't answer.")).toBe(
      "`reply` needs Slack, which the bridge can't use right now. Slack didn't answer. Until then it runs only `status` and `pause`.",
    );
    expect(refusal("refused", null)).toBe(
      "`reply` needs Slack, which the bridge can't use right now. Until then it runs only `status` and `pause`.",
    );
  });

  test("names only the commands the caller's role may run without Slack, as the CLI offers them", () => {
    const runs = (role: CallerRole) =>
      refuseWithoutSlack("`reply`", rejected, contracts, role).message.split("Until then ")[1];

    expect(runs("operator")).toBe("it runs only `status`, `doctor`, and `pause`.");
    expect(runs("member")).toBe("it runs only `status`.");
  });

  test("ends with the problem when the caller may run nothing without Slack", () => {
    const { reply } = contracts;

    expect(refuseWithoutSlack("A widening `set`", rejected, { reply }, "lead").message).toBe(
      "A widening `set` needs Slack, which the bridge can't use right now. Slack rejects SLACK_BOT_TOKEN. Put a working one in credentials.env.",
    );
  });
});

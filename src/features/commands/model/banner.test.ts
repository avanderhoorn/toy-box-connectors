import { describe, expect, test } from "bun:test";
import { presentBanner, type Banner } from "./banner";

function banner(overrides: Partial<Banner>): Banner {
  return { slack: "connected", coverage: "complete", warnings: [], restore: null, ...overrides };
}

describe("presenting the banner", () => {
  test("a healthy bridge says so in one quoted line", () => {
    expect(presentBanner(banner({}))).toBe("> Slack: connected · coverage complete");
  });

  test("anything wrong points to status", () => {
    expect(presentBanner(banner({ coverage: "repairing" }))).toBe(
      "> Slack: connected · coverage repairing, see `toy-box-slack status`",
    );
    expect(presentBanner(banner({ slack: "auth_failed" }))).toBe(
      "> Slack: tokens rejected · coverage complete, see `toy-box-slack status`",
    );
  });

  test("leaves coverage out when no linked channel is in view", () => {
    expect(presentBanner(banner({ coverage: null }))).toBe("> Slack: connected");
    expect(presentBanner(banner({ slack: "unconfigured", coverage: null }))).toBe(
      "> Slack: not set up, see `toy-box-slack status`",
    );
  });

  test("names posts the bridge couldn't confirm by item", () => {
    expect(
      presentBanner(
        banner({
          warnings: [{ kind: "delivery_unknown", posts: [{ item: "o31", kind: "reply" }] }],
        }),
      ),
    ).toBe(
      "> Slack: connected · coverage complete · 1 reply delivery unknown (o31), see `toy-box-slack status`",
    );
    const posts = [
      { item: "o31", kind: "reply" },
      { item: "o33", kind: "reply" },
    ] as const;
    expect(presentBanner(banner({ warnings: [{ kind: "stray", posts: [...posts] }] }))).toContain(
      "2 replies outside their threads (o31, o33)",
    );
    const mixed = [...posts, { item: "o34", kind: "publication" }] as const;
    expect(
      presentBanner(banner({ warnings: [{ kind: "delivery_unknown", posts: [...mixed] }] })),
    ).toContain("3 posts delivery unknown (o31, o33, o34)");
  });

  test("explains a missing or drifted routine with the command it needs", () => {
    expect(presentBanner(banner({ warnings: [{ kind: "routine_missing", series: null }] }))).toBe(
      "> Slack: connected · coverage complete · the requests routine is gone, register a new one with `toy-box-slack routine --requests <id>`, see `toy-box-slack status`",
    );
    expect(
      presentBanner(banner({ warnings: [{ kind: "routine_drifted", series: "release-notes" }] })),
    ).toContain(
      "the release-notes routine no longer runs `toy-box-slack publish --series release-notes`",
    );
    expect(
      presentBanner(banner({ warnings: [{ kind: "routine_drifted", series: null }] })),
    ).toContain("the requests routine no longer runs `toy-box-slack inbox`");
  });

  test("hands a lead back what it was waiting for, with its wake when it had one", () => {
    expect(
      presentBanner(
        banner({ restore: { waitingFor: "Bridge Engineer's s3", wakeAfterMinutes: 25 } }),
      ).split("\n"),
    ).toEqual([
      "> Slack: connected · coverage complete",
      `> Before this turn you were waiting for "Bridge Engineer's s3". If that's still true when you finish, call finish_agent_turn with that waitingFor and wakeAfterMinutes 25.`,
    ]);
    expect(
      presentBanner(banner({ restore: { waitingFor: "CI", wakeAfterMinutes: null } })),
    ).toEndWith(`call finish_agent_turn with that waitingFor.`);
  });

  test("keeps a waiting status with line breaks inside the quote", () => {
    const restore = { waitingFor: "the owner\n> and CI", wakeAfterMinutes: null };
    expect(presentBanner(banner({ restore })).split("\n")).toHaveLength(2);
  });
});

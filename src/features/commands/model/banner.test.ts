import { describe, expect, test } from "bun:test";
import { composeBanner, presentBanner, type Banner, type LinkHealth } from "./banner";

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

  test("says when the link is paused or suspended, because its posts wait", () => {
    expect(
      presentBanner(
        banner({ warnings: [{ kind: "link_inactive", status: "paused", reason: null }] }),
      ),
    ).toBe(
      "> Slack: connected · coverage complete · link paused, its posts wait until it's resumed, see `toy-box-slack status`",
    );
    expect(
      presentBanner(
        banner({
          warnings: [
            { kind: "link_inactive", status: "suspended", reason: "toybox_channel_deleted" },
          ],
        }),
      ),
    ).toContain("link suspended because its Toy Box channel was deleted, its posts wait,");
    expect(
      presentBanner(
        banner({
          warnings: [{ kind: "link_inactive", status: "suspended", reason: "bot_removed" }],
        }),
      ),
    ).toContain(
      "link suspended because the bot was removed from its Slack channel, its posts wait,",
    );
    expect(
      presentBanner(
        banner({
          warnings: [{ kind: "link_inactive", status: "suspended", reason: "restricted_action" }],
        }),
      ),
    ).toContain("link suspended (restricted_action), its posts wait,");
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

describe("composing the banner", () => {
  const healthy: LinkHealth = {
    status: "active",
    statusReason: null,
    coverage: "complete",
    routines: [{ series: null, state: "present" }],
  };
  const quiet = { slack: "connected", links: [healthy], posts: [], restore: null } as const;

  test("a healthy link has no warnings, and no link in view leaves coverage out", () => {
    expect(composeBanner(quiet)).toEqual({
      slack: "connected",
      coverage: "complete",
      warnings: [],
      restore: null,
    });
    expect(composeBanner({ ...quiet, links: [] }).coverage).toBeNull();
  });

  test("coverage is the worst of the links, a repair under way first", () => {
    const coverage = (...coverages: LinkHealth["coverage"][]) =>
      composeBanner({ ...quiet, links: coverages.map((one) => ({ ...healthy, coverage: one })) })
        .coverage;
    expect(coverage("complete", "partial")).toBe("partial");
    expect(coverage("partial", "repairing", "complete")).toBe("repairing");
  });

  test("names an inactive link with why it was suspended, and each routine that needs a person", () => {
    const links: LinkHealth[] = [
      { ...healthy, status: "paused", statusReason: "paused_by_operator" },
      {
        ...healthy,
        status: "suspended",
        statusReason: "bot_removed",
        routines: [
          { series: null, state: "missing" },
          { series: "release-notes", state: "drifted" },
          { series: "digest", state: "present" },
        ],
      },
    ];
    expect(composeBanner({ ...quiet, links }).warnings).toEqual([
      { kind: "link_inactive", status: "paused", reason: null },
      { kind: "link_inactive", status: "suspended", reason: "bot_removed" },
      { kind: "routine_missing", series: null },
      { kind: "routine_drifted", series: "release-notes" },
    ]);
  });

  test("groups unsettled posts by what's unsettled, in the order given", () => {
    const posts = [
      { item: "o3", kind: "reply", state: "stray" },
      { item: "o5", kind: "publication", state: "delivery_unknown" },
      { item: "o8", kind: "reply", state: "delivery_unknown" },
    ] as const;
    expect(composeBanner({ ...quiet, posts }).warnings).toEqual([
      {
        kind: "delivery_unknown",
        posts: [
          { item: "o5", kind: "publication" },
          { item: "o8", kind: "reply" },
        ],
      },
      { kind: "stray", posts: [{ item: "o3", kind: "reply" }] },
    ]);
  });

  test("names a warning two links share once", () => {
    const paused = { ...healthy, status: "paused" as const, routines: [] };
    expect(composeBanner({ ...quiet, links: [paused, paused] }).warnings).toEqual([
      { kind: "link_inactive", status: "paused", reason: null },
    ]);
  });

  test("passes a lead's restore through", () => {
    const restore = { waitingFor: "Alice's review", wakeAfterMinutes: 30 };
    expect(composeBanner({ ...quiet, restore }).restore).toBe(restore);
  });
});

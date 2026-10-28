import { describe, expect, test } from "bun:test";
import {
  allowlistField,
  APPROVE_ACTION_ID,
  MAX_ALLOWED_PER_PROPOSAL,
  REJECT_ACTION_ID,
  type Approval,
  type ReadSet,
} from "./approvals";
import type { Audience } from "./audience";
import {
  cardPeople,
  renderCard,
  SECTION_LIMIT,
  type CardBlock,
  type CardMessage,
  type CardNames,
} from "./cards";
import { pendingApproval } from "./testFixtures";

const names = {
  U0CAROL: "Carol Chen",
  U0DANA: "Dana Diaz",
  U0DEV: "Dev Patel",
  U0ERIN: "Erin Wu",
};

function audience(channelId: string, changes: Partial<Audience> = {}): Audience {
  return {
    channelId,
    kind: "private",
    external: false,
    orgShared: false,
    enterpriseId: null,
    workspaces: ["T0HOME"],
    ...changes,
  };
}

function readSet(changes: Partial<ReadSet> = {}): ReadSet {
  return {
    ownerUserId: "U0OWNER",
    link: { id: "link", status: "active", statusReason: null },
    monitored: audience("C0LINK"),
    publish: audience("C0LINK"),
    before: {},
    ...changes,
  };
}

/** A pending proposal, a7, asking U0OWNER to allow U0CAROL in the private channel C0LINK. */
function approval(changes: Partial<Approval> = {}): Approval {
  return pendingApproval({
    id: "approval-7",
    number: 7,
    patch: [{ field: "allowlist.U0CAROL", after: { label: null } }],
    readSet: readSet({ before: { "allowlist.U0CAROL": null } }),
    card: { channelId: "C0LINK", ts: null },
    ...changes,
  });
}

function allow(...people: string[]): Approval {
  return approval({
    patch: people.map((userId) => ({ field: allowlistField(userId), after: { label: null } })),
  });
}

function section(text: string): CardBlock {
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

function context(text: string): CardBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text, verbatim: true }] };
}

/** Every text on a card that Slack formats, in order. */
function texts(card: CardMessage): string[] {
  return card.blocks.flatMap((block) => {
    switch (block.type) {
      case "section":
        return [block.text.text];
      case "context":
        return block.elements.map((element) => element.text);
      case "actions":
        return [];
    }
  });
}

/** The texts of the sections between a card's headline and its closing context lines. */
function detailSections(card: CardMessage): string[] {
  return card.blocks
    .slice(1)
    .flatMap((block) => (block.type === "section" ? [block.text.text] : []));
}

function details(card: CardMessage): string[] {
  return detailSections(card).flatMap((text) => text.split("\n"));
}

function stateLine(card: CardMessage): string | undefined {
  const last = card.blocks.at(-1);
  return last?.type === "context" ? last.elements[0]?.text : undefined;
}

function mentions(card: CardMessage): string[] {
  return [card.text, ...texts(card)].flatMap((text) => text.match(/<[@!][^>]*>/g) ?? []);
}

describe("an approval card", () => {
  test("a pending card asks the owner to approve or reject it, and its buttons carry only its ID", () => {
    const headline =
      "<@U0OWNER> Approve letting Carol Chen ask your Toy Box lead for help in <#C0LINK>?";
    expect(renderCard(approval(), names)).toEqual({
      text: headline,
      blocks: [
        section(headline),
        section("• Allows Carol Chen (`U0CAROL`)\n• <#C0LINK> is a private channel"),
        context(
          "The lead acts with your access when it answers people you allow. Approve only if you expected this.",
        ),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: APPROVE_ACTION_ID,
              text: { type: "plain_text", text: "Approve" },
              value: "approval-7",
              style: "primary",
            },
            {
              type: "button",
              action_id: REJECT_ACTION_ID,
              text: { type: "plain_text", text: "Reject" },
              value: "approval-7",
            },
          ],
        },
        context(
          "a7 · Only <@U0OWNER> can approve or reject this · Expires <!date^3600^{date_short_pretty} at {time}|1970-01-01 01:00 UTC>",
        ),
      ],
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("once decided, expired or stale, a card has no buttons and says what happened", () => {
    const decided = { decidedBy: "U0OWNER", decidedAt: 5 };
    const outcomes: [Partial<Approval>, string][] = [
      [{ state: "approved", ...decided }, "a7 · Approved by <@U0OWNER> · Applying it now"],
      [{ state: "applied", ...decided, appliedAt: 6 }, "a7 · Approved by <@U0OWNER> and applied"],
      [{ state: "rejected", ...decided }, "a7 · Rejected by <@U0OWNER>"],
      [{ state: "expired" }, "a7 · Expired before anyone approved it"],
      [
        { state: "stale", staleReason: "channel_made_public" },
        "a7 · No longer applies because one of its channels was made public",
      ],
      [
        { state: "stale", staleReason: "not_verified", ...decided },
        "a7 · Approved by <@U0OWNER>, but it no longer applies because the bridge couldn't check it with Slack and Toy Box in time",
      ],
      [{ state: "stale", staleReason: null }, "a7 · No longer applies"],
    ];
    for (const [changes, line] of outcomes) {
      const card = renderCard(approval(changes), names);
      expect(card.blocks.map((block) => block.type)).toEqual(["section", "section", "context"]);
      expect(stateLine(card)).toBe(line);
    }
    const recorded = { state: "rejected" as const, decidedBy: "W0OWNER", decidedAt: 5 };
    expect(stateLine(renderCard(approval(recorded), names))).toBe("a7 · Rejected by <@W0OWNER>");
  });

  test("it mentions only the owner, never the people it names or hands ownership to", () => {
    const cards = [
      allow("U0CAROL", "U0DEV", "U0ERIN"),
      approval({
        action: "owner",
        patch: [{ field: "owner_user_id", after: "U0DANA" }],
        readSet: readSet({ before: { owner_user_id: "U0OWNER" } }),
      }),
      approval({ state: "rejected", decidedBy: "U0OWNER", decidedAt: 5 }),
    ].map((each) => renderCard(each, names));
    for (const card of cards) {
      const others = mentions(card).filter((mention) => !mention.startsWith("<!date^"));
      expect(new Set(others)).toEqual(new Set(["<@U0OWNER>"]));
    }
  });

  test("every text it formats is verbatim, and the message turns off parsing and unfurling", () => {
    const cards = [
      approval(),
      approval({ state: "applied", decidedBy: "U0OWNER", decidedAt: 5, appliedAt: 6 }),
      approval({ action: "resume", patch: [{ field: "status", after: "active" }] }),
    ].map((each) => renderCard(each, names));
    for (const card of cards) {
      expect(card).toMatchObject({ parse: "none", unfurl_links: false, unfurl_media: false });
      for (const block of card.blocks) {
        const objects =
          block.type === "section" ? [block.text] : block.type === "context" ? block.elements : [];
        for (const object of objects) expect(object).toEqual({ ...object, verbatim: true });
      }
    }
  });

  test("who proposed the change doesn't show, since the lead can claim to be the operator", () => {
    expect(renderCard(approval({ createdBy: "operator" }), names)).toEqual(
      renderCard(approval({ createdBy: "lead" }), names),
    );
  });
});

describe("what a card shows", () => {
  test("a link card shows the channel it watches, where it publishes, how it works and whom it allows", () => {
    const card = renderCard(
      approval({
        linkId: null,
        action: "link",
        patch: [
          { field: "slack_channel_id", after: "C0LINK" },
          { field: "publish_channel_id", after: "C0NEWS" },
          { field: "request_mode", after: "all" },
          { field: "observe", after: "channel" },
          { field: "requests_routine_id", after: "routine-requests" },
          { field: "allowlist.U0CAROL", after: { label: "design" } },
        ],
        readSet: readSet({
          link: "none",
          publish: audience("C0NEWS", { kind: "public" }),
          before: {
            slack_channel_id: null,
            publish_channel_id: null,
            request_mode: null,
            observe: null,
            requests_routine_id: null,
            "allowlist.U0CAROL": null,
          },
        }),
      }),
      names,
    );
    expect(card.text).toBe("<@U0OWNER> Approve linking <#C0LINK> to your Toy Box lead?");
    expect(details(card)).toEqual([
      "• Watches <#C0LINK>",
      "• Publishes to <#C0NEWS>",
      "• Requests: every new message",
      "• Keeps text from: everyone in the channel",
      "• Allows Carol Chen (`U0CAROL`), labelled “design”",
      "• <#C0LINK> is a private channel",
      "• <#C0NEWS> is a public channel",
    ]);
    expect(JSON.stringify(card)).not.toContain("routine-requests");
  });

  test("a link that publishes where it watches names the channel once, with the narrow defaults", () => {
    const card = renderCard(
      approval({
        linkId: null,
        action: "link",
        patch: [
          { field: "slack_channel_id", after: "C0LINK" },
          { field: "publish_channel_id", after: "C0LINK" },
          { field: "request_mode", after: "mention" },
          { field: "observe", after: "requesters" },
        ],
        readSet: readSet({ link: "none" }),
      }),
      names,
    );
    expect(details(card)).toEqual([
      "• Watches <#C0LINK>",
      "• Requests: mentions of the bot",
      "• Keeps text from: people you allow and their threads",
      "• <#C0LINK> is a private channel",
    ]);
    expect(card.blocks.at(-3)).toEqual(context("Approve only if you expected this."));
  });

  test("a set card shows each setting from what it was to what it becomes", () => {
    const card = renderCard(
      approval({
        action: "set",
        patch: [
          { field: "publish_channel_id", after: "C0NEWS" },
          { field: "request_mode", after: "all" },
          { field: "observe", after: "channel" },
        ],
        readSet: readSet({
          publish: audience("C0NEWS", { kind: "public" }),
          before: { publish_channel_id: "C0LINK", request_mode: "mention", observe: "requesters" },
        }),
      }),
      names,
    );
    expect(card.text).toBe("<@U0OWNER> Approve changing how your Toy Box lead works in <#C0LINK>?");
    expect(details(card)).toEqual([
      "• Publishes to <#C0LINK> → <#C0NEWS>",
      "• Requests: mentions of the bot → every new message",
      "• Keeps text from: people you allow and their threads → everyone in the channel",
      "• <#C0LINK> is a private channel",
      "• <#C0NEWS> is a public channel",
    ]);
  });

  test("a resume card shows why the link stopped and who can read its channel now", () => {
    const resume = (link: ReadSet["link"]) =>
      renderCard(
        approval({
          action: "resume",
          patch: [{ field: "status", after: "active" }],
          readSet: readSet({ link, monitored: audience("C0LINK", { kind: "public" }) }),
        }),
        names,
      );
    const suspended = (statusReason: string | null) =>
      details(resume({ id: "link", status: "suspended", statusReason }))[0];
    expect(
      resume({ id: "link", status: "suspended", statusReason: "channel_made_public" }).text,
    ).toBe("<@U0OWNER> Approve resuming your Toy Box lead in <#C0LINK>?");
    expect(
      details(resume({ id: "link", status: "suspended", statusReason: "channel_made_public" })),
    ).toEqual([
      "• The link is suspended because its Slack channel was made public",
      "• <#C0LINK> is a public channel",
    ]);
    expect(suspended("workspace_joined")).toBe(
      "• The link is suspended because a workspace the owner didn't approve joined its Slack channel",
    );
    expect(suspended("toString")).toBe("• The link is suspended");
    expect(suspended(null)).toBe("• The link is suspended");
    expect(details(resume({ id: "link", status: "paused", statusReason: null }))[0]).toBe(
      "• The link is paused",
    );
  });

  test("an owner card names the new owner and warns that they approve every change after", () => {
    const card = renderCard(
      approval({
        action: "owner",
        patch: [{ field: "owner_user_id", after: "U0DANA" }],
        readSet: readSet({ before: { owner_user_id: "U0OWNER" } }),
      }),
      names,
    );
    expect(card.text).toBe(
      "<@U0OWNER> Approve handing ownership of the Slack bridge to Dana Diaz?",
    );
    expect(details(card)).toEqual([
      "• Owner: <@U0OWNER> → Dana Diaz (`U0DANA`)",
      "• <#C0LINK> is a private channel",
    ]);
    expect(card.blocks.at(-3)).toEqual(
      context(
        "The new owner approves every change from then on. Approve only if you expected this.",
      ),
    );
  });

  test("an allow card names one or two people and counts more, and lists everyone it allows", () => {
    expect(renderCard(allow("U0CAROL", "U0DEV"), names).text).toBe(
      "<@U0OWNER> Approve letting Carol Chen and Dev Patel ask your Toy Box lead for help in <#C0LINK>?",
    );
    const three = renderCard(allow("U0CAROL", "U0DEV", "U0ERIN"), names);
    expect(three.text).toBe(
      "<@U0OWNER> Approve letting 3 people ask your Toy Box lead for help in <#C0LINK>?",
    );
    expect(details(three)).toEqual([
      "• Allows Carol Chen (`U0CAROL`)",
      "• Allows Dev Patel (`U0DEV`)",
      "• Allows Erin Wu (`U0ERIN`)",
      "• <#C0LINK> is a private channel",
    ]);
  });

  test("an entry that removes someone shows as removing them, never as allowing them", () => {
    const card = renderCard(
      approval({ patch: [{ field: "allowlist.U0CAROL", after: null }] }),
      names,
    );
    expect(card.text).toBe(
      "<@U0OWNER> Approve changing who can ask your Toy Box lead for help in <#C0LINK>?",
    );
    expect(details(card)).toEqual([
      "• Stops allowing Carol Chen (`U0CAROL`)",
      "• <#C0LINK> is a private channel",
    ]);
    expect(card.blocks.at(-3)).toEqual(context("Approve only if you expected this."));
  });

  test("a channel read beyond one workspace says how far", () => {
    const monitored = (changes: Partial<Audience>) =>
      details(
        renderCard(
          approval({ readSet: readSet({ monitored: audience("C0LINK", changes) }) }),
          names,
        ),
      ).at(-1);
    expect(monitored({ external: true })).toBe(
      "• <#C0LINK> is a private channel shared with another organization",
    );
    expect(
      monitored({ kind: "public", orgShared: true, workspaces: ["T0HOME", "T0A", "T0B"] }),
    ).toBe("• <#C0LINK> is a public channel shared with 3 workspaces in your Enterprise org");
    expect(monitored({ orgShared: true })).toBe(
      "• <#C0LINK> is a private channel shared across your Enterprise org",
    );
    expect(monitored({ workspaces: ["T0HOME", "T0A"] })).toBe(
      "• <#C0LINK> is a private channel in 2 workspaces",
    );
  });
});

describe("text people chose", () => {
  test("a name or label can't mention, link, start code or add a line", () => {
    const card = renderCard(
      approval({
        patch: [{ field: "allowlist.U0CAROL", after: { label: "<https://x.io|y> @everyone" } }],
      }),
      { U0CAROL: "<!channel> @here & `U0OWNER`\n• Allows Admin" },
    );
    expect(details(card)[0]).toBe(
      "• Allows &lt;!channel&gt; @\u200bhere &amp; 'U0OWNER' • Allows Admin (`U0CAROL`), labelled “&lt;https://x.io|y&gt; @\u200beveryone”",
    );
    expect(mentions(card).filter((mention) => mention !== "<@U0OWNER>")).toEqual([
      expect.stringMatching(/^<!date\^/),
    ]);
  });

  test("a long name or label is cut at the card's limit, between whole characters", () => {
    const allowed = (name: string, label: string | null = null) =>
      details(
        renderCard(approval({ patch: [{ field: "allowlist.U0CAROL", after: { label } }] }), {
          U0CAROL: name,
        }),
      )[0];
    expect(allowed("A".repeat(80))).toBe(`• Allows ${"A".repeat(80)} (\`U0CAROL\`)`);
    expect(allowed("A".repeat(81))).toBe(`• Allows ${"A".repeat(79)}… (\`U0CAROL\`)`);
    expect(allowed("&".repeat(30))).toBe(`• Allows ${"&amp;".repeat(15)}… (\`U0CAROL\`)`);
    const family = "👩‍👩‍👧‍👦";
    expect(allowed(family.repeat(10))).toBe(`• Allows ${family.repeat(7)}… (\`U0CAROL\`)`);
    expect(allowed(`Z${"\u0301".repeat(100)}oë`)).toBe("• Allows … (`U0CAROL`)");
    expect(allowed("Carol", "x".repeat(40))).toBe(
      `• Allows Carol (\`U0CAROL\`), labelled “${"x".repeat(40)}”`,
    );
    expect(allowed("Carol", "x".repeat(41))).toBe(
      `• Allows Carol (\`U0CAROL\`), labelled “${"x".repeat(39)}…”`,
    );
  });

  test("direction controls are dropped, so a name can't reorder the ID after it", () => {
    const card = renderCard(approval(), { U0CAROL: "Carol\u202e\u2066 Chen\u200f\u061c" });
    expect(details(card)[0]).toBe("• Allows Carol Chen (`U0CAROL`)");
  });

  test("someone the bridge can't name shows by their ID", () => {
    const unknowns: CardNames[] = [{}, { U0CAROL: null }, { U0CAROL: " \n " }];
    for (const unknown of unknowns) {
      const card = renderCard(approval(), unknown);
      expect(card.text).toBe(
        "<@U0OWNER> Approve letting `U0CAROL` ask your Toy Box lead for help in <#C0LINK>?",
      );
      expect(details(card)[0]).toBe("• Allows `U0CAROL`");
    }
  });

  test("a stored value that isn't a Slack ID shows as text, never as markup", () => {
    const card = renderCard(
      pendingApproval({
        patch: [
          { field: "allowlist.U-carol", after: { label: null } },
          { field: "allowlist.<!here>", after: { label: null } },
          { field: `allowlist.U${"0".repeat(32)}`, after: { label: null } },
        ],
      }),
      {},
    );
    expect(card.text).toBe(
      "U-owner Approve letting 3 people ask your Toy Box lead for help in C-link?",
    );
    expect(details(card)).toEqual([
      "• Allows U-carol",
      "• Allows &lt;!here&gt;",
      `• Allows U${"0".repeat(32)}`,
      "• C-link is a private channel",
    ]);
    expect(stateLine(card)).toStartWith("a1 · Only U-owner can approve or reject this");
    expect(mentions(card)).toEqual([expect.stringMatching(/^<!date\^/)]);
  });
});

describe("a card's size", () => {
  test("lines fill a section up to exactly its limit, and one that would pass it starts the next", () => {
    const people = Array.from({ length: 31 }, (_, index) => `U0P${String(index).padStart(2, "0")}`);
    // Each line is "• Allows " (9), the name and " (`U0Pnn`)" (10). Thirty names of 77 make 30
    // lines of 96, 2,909 characters with their newlines, so a last line of 90 fills 3,000.
    const sections = (lastName: number) =>
      detailSections(
        renderCard(
          allow(...people),
          Object.fromEntries(
            people.map((userId, index) => [userId, "y".repeat(index === 30 ? lastName : 77)]),
          ),
        ),
      );
    const exact = sections(71);
    expect(exact[0]).toHaveLength(SECTION_LIMIT);
    expect(exact[0]?.split("\n")).toHaveLength(31);
    const over = sections(72);
    expect(over[0]).toHaveLength(2909);
    expect(over[1]).toStartWith(`• Allows ${"y".repeat(72)} (\`U0P30\`)\n`);
  });

  test("the most people a proposal can allow, with the longest names and labels, fit one card", () => {
    const people = Array.from(
      { length: MAX_ALLOWED_PER_PROPOSAL },
      (_, index) => `U${String(index).padStart(31, "0")}`,
    );
    const card = renderCard(
      approval({
        linkId: null,
        action: "link",
        patch: [
          { field: "slack_channel_id", after: "C0LINK" },
          { field: "publish_channel_id", after: "C0NEWS" },
          { field: "request_mode", after: "all" },
          { field: "observe", after: "channel" },
          ...people.map((userId) => ({
            field: allowlistField(userId),
            after: { label: "<".repeat(100) },
          })),
        ],
        readSet: readSet({
          link: "none",
          publish: audience("C0NEWS", {
            kind: "public",
            orgShared: true,
            workspaces: ["T0A", "T0B"],
          }),
        }),
      }),
      Object.fromEntries(people.map((userId) => [userId, "&".repeat(200)])),
    );
    expect(card.blocks.length).toBeLessThanOrEqual(50);
    for (const text of texts(card)) expect(text.length).toBeLessThanOrEqual(SECTION_LIMIT);
    // The most text the outbox lets any one message carry.
    expect(texts(card).join("").length).toBeLessThanOrEqual(12_000);
    for (const userId of people) {
      expect(details(card).filter((line) => line.includes(`(\`${userId}\`)`))).toHaveLength(1);
    }
  });
});

describe("the people a card names", () => {
  test("are everyone whose access it changes and any new owner, once each", () => {
    expect(
      cardPeople({
        patch: [
          { field: "request_mode", after: "all" },
          { field: "allowlist.U0CAROL", after: { label: null } },
          { field: "allowlist.U0DEV", after: null },
          { field: "owner_user_id", after: "U0DANA" },
        ],
      }),
    ).toEqual(["U0CAROL", "U0DEV", "U0DANA"]);
    expect(
      cardPeople({
        patch: [
          { field: "allowlist.U0CAROL", after: { label: null } },
          { field: "owner_user_id", after: "U0CAROL" },
        ],
      }),
    ).toEqual(["U0CAROL"]);
  });
});

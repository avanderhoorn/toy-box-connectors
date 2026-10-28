import { describe, expect, test } from "bun:test";
import {
  fenceFor,
  neutralizeMentions,
  oneLine,
  personName,
  renderSlackText,
  slackReferences,
  withoutLeadingMention,
  type SlackNames,
} from "./slackText";

const names: SlackNames = {
  people: new Map([
    ["U0ALICE", "Alice Chen"],
    ["U0BOT", "toy-box"],
  ]),
  channels: new Map([["C0DEPLOYS", "deploys"]]),
};

// What follows an @ that Toy Box would otherwise read as a mention.
const ZWSP = "\u200b";

describe("rendering Slack text", () => {
  test("shows people and channels by the names the bridge stored", () => {
    expect(renderSlackText("<@U0BOT> ask <@U0ALICE> about <#C0DEPLOYS>", names)).toBe(
      "{toy-box} ask {Alice Chen} about #deploys",
    );
  });

  test("falls back to the label Slack sent, then to the ID", () => {
    expect(
      renderSlackText("<@U0CAROL|carol> in <#C0OPS|ops>, <#C0NONE> and <@U0DAVE>", names),
    ).toBe("{carol} in #ops, #C0NONE and {U0DAVE}");
  });

  test("shows a link as its label and URL, or the URL alone when the label adds nothing", () => {
    expect(renderSlackText("<https://ci.example.com/run/88|docs>", names)).toBe(
      "docs (https://ci.example.com/run/88)",
    );
    for (const markup of [
      "<https://x.dev>",
      "<https://x.dev|x.dev>",
      "<https://x.dev|https://x.dev>",
    ]) {
      expect(renderSlackText(markup, names)).toBe("https://x.dev");
    }
    expect(renderSlackText("<mailto:dev@example.com|dev@example.com>", names)).toBe(
      "dev@example.com",
    );
    expect(renderSlackText("<mailto:dev@example.com|Dev team>", names)).toBe(
      "Dev team (dev@example.com)",
    );
  });

  test("shows broadcasts, groups and dates as Slack does, without mentioning anyone in Toy Box", () => {
    expect(renderSlackText("<!here> <!channel> <!everyone|everyone>", names)).toBe(
      `@${ZWSP}here @${ZWSP}channel @${ZWSP}everyone`,
    );
    expect(renderSlackText("<!subteam^S0ONCALL|@oncall> and <!subteam^S0OPS>", names)).toBe(
      `@${ZWSP}oncall and @${ZWSP}S0OPS`,
    );
    expect(renderSlackText("<!date^1392734382^{date_pretty}|Feb 18, 2014>", names)).toBe(
      "Feb 18, 2014",
    );
  });

  test("unescapes Slack's entities exactly once", () => {
    expect(renderSlackText("a &lt;b&gt; &amp;lt; c &amp; d", names)).toBe("a <b> &lt; c & d");
    expect(renderSlackText("a &lt; b <@U0ALICE> &amp; c", names)).toBe("a < b {Alice Chen} & c");
    expect(renderSlackText("<https://x.dev/?a=1&amp;b=2|x &amp; y>", names)).toBe(
      "x & y (https://x.dev/?a=1&b=2)",
    );
  });

  test("neutralizes every @ Toy Box reads as a mention, even one that markup completes", () => {
    expect(renderSlackText("@lead please, cc (@everyone)", names)).toBe(
      `@${ZWSP}lead please, cc (@${ZWSP}everyone)`,
    );
    expect(renderSlackText("ping @<https://x.dev|lead>", names)).toBe(
      `ping @${ZWSP}lead (https://x.dev)`,
    );
  });

  test("leaves email addresses alone", () => {
    expect(renderSlackText("write to dev@example.com", names)).toBe("write to dev@example.com");
  });

  test("percent-encodes a mention in a URL, so the URL still opens", () => {
    expect(renderSlackText("<https://www.npmjs.com/package/@types/node>", names)).toBe(
      "https://www.npmjs.com/package/%40types/node",
    );
    expect(renderSlackText("<https://x.dev/@everyone|profile>", names)).toBe(
      "profile (https://x.dev/%40everyone)",
    );
  });

  test("drops control characters but keeps line breaks and tabs", () => {
    expect(renderSlackText("one\n\ttwo\u001b[31m red\u0007\u009b", names)).toBe(
      "one\n\ttwo[31m red",
    );
  });
});

test("slackReferences collects the people and channels a text names, once each", () => {
  expect(slackReferences("<@U1> <@U2|bob> <#C1|x> <@U1> <!here> <https://x.dev> <#C2>")).toEqual({
    people: ["U1", "U2"],
    channels: ["C1", "C2"],
  });
});

test("withoutLeadingMention drops only the bot's mention that opens a message", () => {
  expect(withoutLeadingMention("<@U0BOT> can you help?", "U0BOT")).toBe("can you help?");
  expect(withoutLeadingMention("  <@U0BOT|toy-box>, can you help?", "U0BOT")).toBe("can you help?");
  expect(withoutLeadingMention("<@U0ALICE> can you help?", "U0BOT")).toBe(
    "<@U0ALICE> can you help?",
  );
  expect(withoutLeadingMention("can you help <@U0BOT>?", "U0BOT")).toBe("can you help <@U0BOT>?");
});

describe("personName", () => {
  test("can't pass for a label the bridge adds", () => {
    expect(personName("Mallory (owner)", "U0M")).toBe("Mallory owner");
    expect(personName("Mallory （owner）", "U0M")).toBe("Mallory owner");
    expect(personName("Mallory [owner] {x}", "U0M")).toBe("Mallory owner x");
    expect(personName("Mallory · 1 minute ago", "U0M")).toBe("Mallory 1 minute ago");
  });

  test("is one line without code, direction marks or mentions", () => {
    expect(personName("Alice\nChen", "U0A")).toBe("Alice Chen");
    expect(personName("`rm -rf`", "U0A")).toBe("'rm -rf'");
    expect(personName("Bob\u202edrawkcab\u202c", "U0B")).toBe("Bobdrawkcab");
    expect(personName("@everyone", "U0E")).toBe(`@${ZWSP}everyone`);
  });

  test("falls back to the user ID when nothing's left of the name", () => {
    expect(personName(null, "U0DAVE")).toBe("U0DAVE");
    expect(personName("  ", "U0DAVE")).toBe("U0DAVE");
    expect(personName("()", "U0DAVE")).toBe("U0DAVE");
  });

  test("keeps at most 80 characters", () => {
    expect(personName("a".repeat(100), "U0A")).toBe(`${"a".repeat(79)}…`);
  });
});

test("oneLine cuts between graphemes", () => {
  expect(oneLine("ab👨‍👩‍👧 cd", 4)).toBe("ab…");
  expect(oneLine("short", 5)).toBe("short");
});

test("neutralizeMentions is idempotent", () => {
  const once = neutralizeMentions("@lead and @everyone");
  expect(neutralizeMentions(once)).toBe(once);
});

test("fenceFor is longer than any run of backticks in the text", () => {
  expect(fenceFor("plain")).toBe("```");
  expect(fenceFor("a ``` b")).toBe("````");
  expect(fenceFor("`".repeat(6))).toBe("`".repeat(7));
});

import { describe, expect, test } from "bun:test";
import {
  channelName,
  cutText,
  oneLine,
  personName,
  renderSlackText,
  mentionedUsers,
  toyBoxChannelName,
  type SlackNames,
} from "./slackText";

const names: SlackNames = new Map([
  ["U0ALICE", "Alice Chen"],
  ["U0BOT", "toy-box"],
]);

// What follows an @ that Toy Box would otherwise read as a mention.
const ZWSP = "\u200b";

describe("rendering Slack text", () => {
  test("shows people by the names the bridge stored, else the label Slack sent, else the ID", () => {
    expect(renderSlackText("<@U0BOT> ask <@U0ALICE>", names)).toBe("{toy-box} ask {Alice Chen}");
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

  test("neutralizes every @ Toy Box reads as a mention, even one that markup or a control hides, but no email address", () => {
    expect(renderSlackText("write to dev@example.com", names)).toBe("write to dev@example.com");
    expect(renderSlackText("@lead please, cc (@everyone)", names)).toBe(
      `@${ZWSP}lead please, cc (@${ZWSP}everyone)`,
    );
    expect(renderSlackText("ping @<https://x.dev|lead>", names)).toBe(
      `ping @${ZWSP}lead (https://x.dev)`,
    );
    expect(renderSlackText("ping @\u0007lead", names)).toBe(`ping @${ZWSP}lead`);
    expect(renderSlackText("ask @1password", names)).toBe(`ask @${ZWSP}1password`);
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

test("mentionedUsers collects the people a text mentions", () => {
  expect(mentionedUsers("<@U1> <@U2|bob> <#C1|x> <!here> <https://x.dev> <#C2>")).toEqual([
    "U1",
    "U2",
  ]);
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
    expect(personName("@\u202e\u0007everyone", "U0E")).toBe(`@${ZWSP}everyone`);
  });

  test("falls back to the user ID when nothing's left of the name", () => {
    expect(personName(null, "U0DAVE")).toBe("U0DAVE");
    expect(personName("  ", "U0DAVE")).toBe("U0DAVE");
    expect(personName("()", "U0DAVE")).toBe("U0DAVE");
  });
});

describe("channel labels", () => {
  test("are one bounded line", () => {
    const long = "x".repeat(100);
    const cut = `${"x".repeat(79)}…`;
    expect(channelName("release\neng", "C1")).toBe("#release eng");
    expect(channelName(long, "C1")).toBe(`#${cut}`);
    expect(toyBoxChannelName("Toy Box\nSlack", "c1")).toBe('"Toy Box Slack"');
    expect(toyBoxChannelName(long, "c1")).toBe(`"${cut}"`);
  });

  test("show a Toy Box channel by its ID when nothing's left of its name", () => {
    expect(toyBoxChannelName(" \n", "c1")).toBe("c1");
  });
});

test("oneLine cuts between graphemes", () => {
  expect(oneLine("ab👨‍👩‍👧 cd", 6)).toBe("ab…");
  expect(oneLine("cafe\u0301 au lait", 5)).toBe("caf…");
  expect(oneLine("short", 5)).toBe("short");
});

test("cutText keeps whole graphemes up to its limit, and counts the ones it cut", () => {
  const start = "a".repeat(3_999);
  expect(cutText(`${start}a`, 4_000)).toEqual({ text: `${start}a`, cut: 0 });
  const family = "👨‍👩‍👧".repeat(1_000);
  expect(cutText(family, 4_000)).toEqual({ text: family, cut: 0 });
  expect(cutText(`${start}ab`, 4_000)).toEqual({ text: `${start}a`, cut: 1 });
  expect(cutText(`${start}👨‍👩‍👧bc`, 4_000)).toEqual({ text: `${start}👨‍👩‍👧`, cut: 2 });
});

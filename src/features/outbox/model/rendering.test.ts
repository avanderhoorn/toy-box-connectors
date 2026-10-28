import { expect, test } from "bun:test";
import { describeRenderingRefusal, renderMarkdown, type RenderedMessage } from "./rendering";

function rendered(source: string): RenderedMessage {
  const result = renderMarkdown(source);
  if (result.kind !== "rendered") throw new Error(`Unexpected refusal: ${result.problem}`);
  return result.message;
}

function sections(source: string): string[] {
  return rendered(source).blocks.map((block) => block.text.text);
}

test("Markdown becomes mrkdwn sections with a plain, accessible fallback", () => {
  const message = rendered(
    "# Release\n\nShipped **bold**, *italic*, ~~old~~ and `code`.\n\n[Read more](https://example.com/a?q=a&b=c)",
  );
  expect(message.blocks.map((block) => block.text.text)).toEqual([
    "*Release*\n\nShipped *bold*, _italic_, ~old~ and `code`.\n\n" +
      "<https://example.com/a?q=a&amp;b=c|Read more>",
  ]);
  expect(message.text).toBe(
    "Release\n\nShipped bold, italic, old and code.\n\nRead more (https://example.com/a?q=a&amp;b=c)",
  );
  expect(message).toMatchObject({
    mrkdwn: false,
    parse: "none",
    unfurl_links: false,
    unfurl_media: false,
  });
  expect(message).not.toHaveProperty("link_names");
  for (const block of message.blocks) {
    expect(block.type).toBe("section");
    expect(block.text.type).toBe("mrkdwn");
    expect(block.text.verbatim).toBe(true);
  }
});

test("raw Slack controls, HTML and named broadcasts cannot mention anyone", () => {
  const message = rendered(
    "A & B <@U123> <!here> <!channel> <!everyone> @here @channel @everyone\n\n<script>alert(1)</script>",
  );
  const text = message.blocks.map((block) => block.text.text).join("\n");
  expect(text).toContain("A &amp; B &lt;@U123&gt; &lt;!here&gt;");
  expect(text).toContain("@\u200bhere @\u200bchannel @\u200beveryone");
  expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(text).not.toContain("<@");
  expect(text).not.toContain("<!");
  expect(message.text).not.toMatch(/@(here|channel|everyone)\b/);
});

test("inline and block HTML are escaped, and raw ampersands are escaped exactly once", () => {
  expect(sections("a & b\n\nbefore <c> after\n\n<!here> <@U1>")).toEqual([
    "a &amp; b\n\nbefore &lt;c&gt; after\n\n&lt;!here&gt; &lt;@U1&gt;",
  ]);
});

test("lists, task lists, quotes, images, tables and rules retain their content", () => {
  const message = rendered(
    [
      "3. First\n4. Second",
      "- [x] Done\n- [ ] Next",
      "> Quoted\n>\n> Again",
      "![Diagram](https://example.com/diagram.png)",
      "Name | State\n--- | ---\nBridge | Ready",
      "---",
    ].join("\n\n"),
  );
  expect(message.blocks.map((block) => block.text.text)).toEqual([
    [
      "3. First\n4. Second",
      "- [x] Done\n- [ ] Next",
      "> Quoted\n> \n> Again",
      "<https://example.com/diagram.png|Diagram>",
      "*Name* | *State*\nBridge | Ready",
      "---",
    ].join("\n\n"),
  ]);
  expect(message.text).toContain("Diagram (https://example.com/diagram.png)");
});

test("nested and loose task lists keep their nesting without repeated checkboxes", () => {
  expect(sections("- Outer\n  - Inner")).toEqual(["- Outer\n  - Inner"]);
  expect(sections("- [x] First\n\n  Another paragraph")).toEqual([
    "- [x] First\n  \n  Another paragraph",
  ]);
  expect(sections("# **Already bold**")).toEqual(["*Already bold*"]);
});

test("reference links and bare public URLs use the same validated link path", () => {
  expect(
    sections(
      '[Docs][ref]\n\nhttps://example.com/b\n\n[ref]: https://example.com/a "Documentation"',
    ),
  ).toEqual(["<https://example.com/a|Docs>\n\n<https://example.com/b|https://example.com/b>"]);
});

test.each([
  "[bad](javascript:alert(1))",
  "[bad](java&#115;cript:alert(1))",
  "![bad](file:///Users/owner/work)",
  "[bad](ftp://example.com/file)",
  "[bad](/relative)",
  "[bad][ref]\n\n[ref]: ftp://example.com",
])("unsafe Markdown destinations are refused: %s", (source) => {
  expect(renderMarkdown(source)).toEqual({ kind: "refused", problem: "unsafe_link" });
});

test("email addresses, git remotes and non-HTTP autolinks stay plain text", () => {
  for (const source of [
    "support@github.com",
    "git@github.com:github/toy-box.git",
    "ftp://example.com/file",
    "Mail me at someone@example.com",
    "The remote is git@github.com:org/repo.git",
    "Clone ssh://git@github.com/org/repo.git",
    "Download ftp://example.com/file",
  ]) {
    expect(sections(source)).toEqual([source]);
  }
  expect(sections("<a@b.c>")).toEqual(["a@b.c"]);
  expect(sections("[Email us](mailto:support@example.com)")).toEqual([
    "Email us (support@example.com)",
  ]);
  expect(sections("<javascript:alert(1)>")).toEqual(["javascript:alert(1)"]);
  expect(sections("Write to [the owner](mailto:owner@example.com)")).toEqual([
    "Write to the owner (owner@example.com)",
  ]);
});

test("a link label cannot inject Slack controls or a new destination", () => {
  const [section] = sections(
    "[hello | <!here> <@U123>](https://example.com/a%3E%3C@U456%3E?q=x|y)",
  );
  expect(section).toBe(
    "<https://example.com/a%3E%3C@U456%3E?q=x%7Cy|hello | &lt;!here&gt; &lt;@U123&gt;>",
  );
  expect(section?.match(/</g)).toHaveLength(1);
  expect(section?.match(/>/g)).toHaveLength(1);
});

test("secrets formed by Markdown normalization are still refused", () => {
  expect(renderMarkdown(`ghp\\_${"a".repeat(36)}`)).toEqual({
    kind: "refused",
    problem: "github_token",
  });
});

test("private destinations are refused in every clickable form", () => {
  for (const source of [
    "[service](https://[::1]:3100)",
    "![service](https://10.1.2.3)",
    "[service][ref]\n\n[ref]: https://host.internal",
    "http://2130706433:3100",
    "www.service.internal",
  ]) {
    expect(renderMarkdown(source)).toEqual({ kind: "refused", problem: "private_link" });
  }
});

test("URLs inside code stay literal, so private addresses there are allowed", () => {
  expect(sections("Use `http://localhost:3000` locally.")).toEqual([
    "Use `http://localhost:3000` locally.",
  ]);
  expect(sections("```\nhttps://[::1]:3100\n```")).toEqual(["```\nhttps://[::1]:3100\n```"]);
  expect(sections("www.example.com")).toEqual(["<http://www.example.com/|www.example.com>"]);
});

test("password-bearing URLs are secrets even when code prevents them from being clickable", () => {
  const url = `https://${"example-user"}:${"example-password"}@example.com`;
  for (const source of [url, `[link](${url})`, `\`${url}\``, `\`\`\`\n${url}\n\`\`\``]) {
    expect(renderMarkdown(source)).toEqual({ kind: "refused", problem: "url_credentials" });
  }
});

test("a section accepts exactly 3000 characters and refuses an indivisible 3001-character line", () => {
  expect(sections("a".repeat(3_000))).toEqual(["a".repeat(3_000)]);
  expect(renderMarkdown("a".repeat(3_001))).toMatchObject({
    kind: "refused",
    problem: "section_too_long",
    limit: 3_000,
    actual: 3_001,
  });
  expect(sections("a".repeat(3_000) + "\nb")).toEqual(["a".repeat(3_000), "b"]);
});

test("lines totaling exactly 3000 stay together, while 3001 breaks between lines", () => {
  const first = "a".repeat(1_499);
  expect(sections(first + "\n" + "b".repeat(1_500))).toEqual([first + "\n" + "b".repeat(1_500)]);
  expect(sections(first + "\n" + "b".repeat(1_501))).toEqual([first, "b".repeat(1_501)]);
});

test("whole blocks pack greedily up to 3000 characters, with a blank line between them", () => {
  const first = "a".repeat(1_499);
  expect(sections(first + "\n\n" + "b".repeat(1_499))).toEqual([
    first + "\n\n" + "b".repeat(1_499),
  ]);
  expect(sections(first + "\n\n" + "b".repeat(1_500))).toEqual([first, "b".repeat(1_500)]);
});

test("entities remain whole when escaping expands a section past its boundary", () => {
  expect(sections("a".repeat(2_999) + "\n&<>")).toEqual(["a".repeat(2_999), "&amp;&lt;&gt;"]);
  expect(sections("&".repeat(600))).toEqual(["&amp;".repeat(600)]);
  expect(renderMarkdown("&".repeat(601))).toMatchObject({
    kind: "refused",
    problem: "section_too_long",
    limit: 3_000,
    actual: 3_005,
  });
});

test("surrogate pairs stay whole at section boundaries", () => {
  const source = "a".repeat(2_999) + "\n\u{1f680}";
  expect(sections(source)).toEqual(["a".repeat(2_999), "\u{1f680}"]);
  expect(sections("\u{1f680}".repeat(1_500))).toEqual(["\u{1f680}".repeat(1_500)]);
  expect(renderMarkdown("\u{1f680}".repeat(1_501))).toMatchObject({
    kind: "refused",
    problem: "section_too_long",
    limit: 3_000,
    actual: 3_002,
  });
});

test("nested formatting closes and reopens without exceeding section limits", () => {
  const result = sections(`**_${"a".repeat(2_996)}\nbbbbb_**`);
  expect(result).toEqual(["*_".concat("a".repeat(2_996), "_*"), "*_bbbbb_*"]);
  expect(result.map((section) => section.length)).toEqual([3_000, 9]);
});

test("a quote retains its prefix when an oversized block breaks between lines", () => {
  expect(sections("> " + "a".repeat(2_998) + "\n> next")).toEqual([
    "> " + "a".repeat(2_998),
    "> next",
  ]);
});

test("code fences close and reopen and literal triples cannot escape them", () => {
  expect(sections(`\`\`\`ts\n${"x".repeat(2_992)}\n${"x".repeat(8)}\n\`\`\``)).toEqual([
    "```\n" + "x".repeat(2_992) + "\n```",
    "```\n" + "x".repeat(8) + "\n```",
  ]);
  expect(sections("```````\n``````\n```````")).toEqual(["```\n" + "`\u200b".repeat(4) + "``\n```"]);
});

test("a generated link is never divided between sections", () => {
  const label = "label";
  const url = "https://example.com";
  expect(sections("a".repeat(2_990) + `\n[${label}](${url})`)).toEqual([
    "a".repeat(2_990),
    `<${url}/|${label}>`,
  ]);
  expect(renderMarkdown(`[${"a".repeat(3_000)}](${url})`)).toMatchObject({
    kind: "refused",
    problem: "section_too_long",
    limit: 3_000,
    actual: 3_023,
  });
});

test("a message accepts exactly 12000 rendered characters and refuses 12001", () => {
  const source = [...Array<string>(3).fill("a".repeat(3_000)), "a".repeat(2_997)].join("\n");
  expect(rendered(source).text).toHaveLength(12_000);
  expect(renderMarkdown(source + "a")).toEqual({
    kind: "refused",
    problem: "message_too_long",
    limit: 12_000,
    actual: 12_001,
    surface: "fallback",
  });
  const code = Array.from({ length: 4 }, () => "```\n" + "a".repeat(2_992) + "\n```").join("\n\n");
  expect(sections(code).reduce((length, section) => length + section.length, 0)).toBe(12_000);
  expect(renderMarkdown(code + "\n\nx")).toEqual({
    kind: "refused",
    problem: "message_too_long",
    limit: 12_000,
    actual: 12_001,
    surface: "sections",
  });
});

test("the plain fallback has the same 12000-character limit", () => {
  const source = Array.from({ length: 50 }, () => "a".repeat(239)).join("\n\n");
  expect(renderMarkdown(source)).toEqual({
    kind: "refused",
    problem: "message_too_long",
    limit: 12_000,
    actual: 12_048,
    surface: "fallback",
  });
});

test("a release with many short paragraphs does not hit a spurious block limit", () => {
  expect(rendered(Array.from({ length: 60 }, () => "paragraph").join("\n\n")).blocks).toHaveLength(
    1,
  );
});

test("the defensive block cap allows 50 before applying the smaller character limit", () => {
  const block = "a".repeat(1_501);
  expect(renderMarkdown(Array.from({ length: 50 }, () => block).join("\n\n"))).toMatchObject({
    kind: "refused",
    problem: "message_too_long",
    limit: 12_000,
  });
  expect(renderMarkdown(Array.from({ length: 51 }, () => block).join("\n\n"))).toEqual({
    kind: "refused",
    problem: "too_many_blocks",
    limit: 50,
    actual: 51,
  });
});

test("a long-line refusal identifies the rendered line and a short preview, never its entire text", () => {
  const source = "# Title\n\nFirst line.\nThis sentence is too long " + "x".repeat(3_000);
  expect(renderMarkdown(source)).toEqual({
    kind: "refused",
    problem: "section_too_long",
    limit: 3_000,
    actual: 3_026,
    line: 4,
    preview: "This sentence is too long " + "x".repeat(54),
  });
});

test("refusal text names the limit and repair, without echoing a secret", () => {
  expect(
    describeRenderingRefusal({
      kind: "refused",
      problem: "section_too_long",
      limit: 3_000,
      actual: 3_001,
      line: 4,
      preview: "This is the long line",
    }),
  ).toBe(
    'Rendered line 4 ("This is the long line") needs 3001 characters, limit 3000 per section. ' +
      "Break it into shorter lines.",
  );
  expect(
    describeRenderingRefusal({
      kind: "refused",
      problem: "message_too_long",
      limit: 12_000,
      actual: 12_001,
      surface: "fallback",
    }),
  ).toContain("plain fallback contains 12001 characters, limit 12000");
  expect(
    describeRenderingRefusal({
      kind: "refused",
      problem: "too_many_blocks",
      limit: 50,
      actual: 51,
    }),
  ).toContain("51 blocks, limit 50");
  const secret = `ghp_${"a".repeat(36)}`;
  const result = renderMarkdown(secret);
  if (result.kind !== "refused") throw new Error("Expected a secret refusal");
  expect(describeRenderingRefusal(result)).toContain("github_token");
  expect(describeRenderingRefusal(result)).not.toContain(secret);
});

test.each(["", " \n\t ", "[ref]: https://example.com", "```\n\n```"])(
  "an empty rendered answer is refused: %s",
  (source) => {
    expect(renderMarkdown(source)).toEqual({ kind: "refused", problem: "empty" });
  },
);

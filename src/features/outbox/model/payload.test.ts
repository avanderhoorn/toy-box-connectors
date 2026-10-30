import { expect, test } from "bun:test";
import { checkLeadPayload } from "./payload";
import { renderMarkdown } from "./rendering";

function message(
  text = "Safe **answer**, `Array<string>` and `a && b`, literal &lt;, &#60;@U1&#62;, <@U1> and @channel.",
  mentions: string[] = [],
) {
  const result = renderMarkdown(text, mentions);
  if (result.kind !== "rendered") throw new Error("Expected rendered text");
  return result.message;
}
test("stored canonical bytes survive JSON and the send check unchanged, naming whom they mention", () => {
  const original = message();
  expect(checkLeadPayload(JSON.parse(JSON.stringify(original)))).toEqual({
    kind: "valid",
    message: original,
    mentions: [],
  });
  const mentioning = message("Shipped.", ["U0ALICE", "W0BOB"]);
  expect(checkLeadPayload(JSON.parse(JSON.stringify(mentioning)))).toEqual({
    kind: "valid",
    message: mentioning,
    mentions: ["U0ALICE", "W0BOB"],
  });
  expect(checkLeadPayload(message("a".repeat(12_000))).kind).toBe("valid");
  expect(checkLeadPayload(message("@\u200b\u200bx and @\u200b\u200b\u200beveryone")).kind).toBe(
    "valid",
  );
});
test("a stored snapshot cannot add controls, change parsing or bypass the limit", () => {
  const original = message();
  for (const change of [
    { parse: "full" },
    { unfurl_links: true },
    { link_names: true },
    { metadata: {} },
    { text: "different fallback" },
    { blocks: [] },
    { blocks: [...original.blocks, ...original.blocks] },
    { text: "a".repeat(12_001) },
  ])
    expect(checkLeadPayload({ ...original, ...change }).kind).toBe("refused");
  for (const text of ["<!here>", "@channel", "<@U1>", `xoxb-${"a".repeat(32)}`, " \n"]) {
    expect(checkLeadPayload({ ...original, text, blocks: [{ type: "markdown", text }] }).kind).toBe(
      "refused",
    );
  }
});
test("a stored snapshot mentions people only on the line the bridge opens its block with", () => {
  const original = message("Shipped.", ["U0ALICE"]);
  for (const text of [
    "<@U0ALICE|alice>\n\nShipped.",
    "<@U0ALICE>  <@W0BOB>\n\nShipped.",
    "<@U0ALICE>\nShipped.",
    "<!here>\n\nShipped.",
    "<!subteam^S0TEAM>\n\nShipped.",
    "<@U0ALICE>\n\nShipped. <@W0BOB>",
    "Shipped.\n\n<@U0ALICE>",
  ])
    expect(checkLeadPayload({ ...original, blocks: [{ type: "markdown", text }] }).kind).toBe(
      "refused",
    );
  // Nor in a fallback text the bridge didn't escape, even beside the block it would render.
  const raw = "<@W0BOB> Shipped.";
  expect(checkLeadPayload({ ...message(raw, ["U0ALICE"]), text: raw }).kind).toBe("refused");
});
test("a stored post shows its images below its text, in order, each headed by its alt text", () => {
  const original = message("The chart.", ["U0ALICE"]);
  const image = (file: string, alt: string) =>
    ({
      type: "image",
      slack_file: { id: file },
      alt_text: alt,
      title: { type: "plain_text", text: alt },
    }) as const;
  const images = [{ alt: "Build minutes per day" }, { alt: "Queue minutes per day" }];
  const stored = JSON.parse(JSON.stringify({ ...original, images }));
  expect(checkLeadPayload(stored, ["F1", "F2"])).toEqual({
    kind: "valid",
    message: {
      ...original,
      blocks: [
        ...original.blocks,
        image("F1", "Build minutes per day"),
        image("F2", "Queue minutes per day"),
      ],
    },
    mentions: ["U0ALICE"],
  });
});
test("a stored post's images match its files, and their alt text passes the text's secret check", () => {
  const original = message("The chart.");
  const alt = (text: string) => ({ ...original, images: [{ alt: text }] });
  for (const [payload, files] of [
    [alt("A chart"), []],
    [original, ["F1"]],
    [alt("A chart"), ["F1", "F2"]],
    [{ ...original, images: [] }, []],
    [{ ...original, images: Array(4).fill({ alt: "A chart" }) }, ["F1", "F2", "F3", "F4"]],
    [alt(""), ["F1"]],
    [alt("a".repeat(1001)), ["F1"]],
    [{ ...original, images: [{ alt: "A chart", file: "F2" }] }, ["F1"]],
  ] as const)
    expect(checkLeadPayload(payload, files).kind).toBe("refused");
  expect(checkLeadPayload(alt("a".repeat(1000)), ["F1"]).kind).toBe("valid");
  expect(checkLeadPayload(alt(`Token xoxb-${"a".repeat(32)}`), ["F1"])).toEqual({
    kind: "refused",
    problem: "slack_token",
  });
});

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

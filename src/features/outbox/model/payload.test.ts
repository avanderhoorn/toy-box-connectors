import { expect, test } from "bun:test";
import { checkLeadPayload } from "./payload";
import { renderMarkdown } from "./rendering";

function message(
  text = "Safe **answer**, `Array<string>` and `a && b`, literal &lt;, &#60;@U1&#62;, <@U1> and @channel.",
) {
  const result = renderMarkdown(text);
  if (result.kind !== "rendered") throw new Error("Expected rendered text");
  return result.message;
}
test("stored canonical bytes survive JSON and the send check unchanged", () => {
  const original = message();
  expect(checkLeadPayload(JSON.parse(JSON.stringify(original)))).toEqual({
    kind: "valid",
    message: original,
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

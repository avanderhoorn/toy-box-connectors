import { expect, test } from "bun:test";
import { renderMarkdown } from "./rendering";

test("one Markdown block retains formatting and makes mentions inert", () => {
  const code = "`Array<string>` and `a && b`\n> quote\n```ts\nif (a < b && c > d) {}\n```\n";
  const result = renderMarkdown(
    `${code}# Heading\n- **bold**\n<!here> @channel <@U123>\n[docs](https://docs.slack.dev/)`,
  );
  if (result.kind !== "rendered") throw new Error("Expected render");
  expect(result.message.blocks).toEqual([{ type: "markdown", text: result.message.text }]);
  expect(result.message.text.slice(0, code.length)).toBe(code);
  expect(result.message.text).toContain("&lt;!here> @\u200bchannel &lt;@U123>");
  expect(renderMarkdown("@\u200bpackage/name")).toHaveProperty("message.text", "@package/name");
  expect(renderMarkdown("@Here, @CHANNEL")).toHaveProperty(
    "message.text",
    "@\u200bHere, @\u200bCHANNEL",
  );
});

test("a post's mentions open only its block, once each and on a line of their own", () => {
  const result = renderMarkdown("# Shipped\nIt's out.", ["U0ALICE", "W0BOB", "U0ALICE"]);
  if (result.kind !== "rendered") throw new Error("Expected render");
  expect(result.message.text).toBe("# Shipped\nIt's out.");
  expect(result.message.blocks).toEqual([
    { type: "markdown", text: "<@U0ALICE> <@W0BOB>\n\n# Shipped\nIt's out." },
  ]);
});

test("the complete escaped message, with its mentions, must fit 12000 characters and exclude blank or secret output", () => {
  expect(renderMarkdown("a".repeat(12_000)).kind).toBe("rendered");
  expect(renderMarkdown("a".repeat(12_001))).toMatchObject({ problem: "message_too_long" });
  expect(renderMarkdown("a".repeat(11_988), ["U0ALICE"]).kind).toBe("rendered");
  expect(renderMarkdown("a".repeat(11_989), ["U0ALICE"])).toMatchObject({
    problem: "message_too_long",
    actual: 12_001,
  });
  expect(renderMarkdown("<@".repeat(2_400)).kind).toBe("rendered");
  expect(renderMarkdown("<@".repeat(2_401))).toMatchObject({ problem: "message_too_long" });
  expect(renderMarkdown(" \n")).toMatchObject({ problem: "empty" });
  expect(renderMarkdown("xoxb-not-a-real-token")).toMatchObject({ problem: "slack_token" });
});

import { expect, test } from "bun:test";
import { renderMarkdown } from "./rendering";
import type { OutputProblem } from "./safety";

test("one Markdown block retains formatting and makes mentions inert", () => {
  const result = renderMarkdown(
    "# Heading\n- **bold**\n```ts\nconst n = 1;\n```\n<!here> @channel <@U123>",
  );
  expect(result.kind).toBe("rendered");
  if (result.kind !== "rendered") throw new Error("Expected render");
  expect(result.message.blocks).toEqual([{ type: "markdown", text: result.message.text }]);
  expect(result.message.text).toContain("&lt;!here&gt; @\u200bchannel &lt;@U123&gt;");
  expect(result.message.parse).toBe("none");
  expect(result.message.unfurl_links).toBe(false);
  expect(result.message.unfurl_media).toBe(false);
  expect(renderMarkdown("@\u200bpackage/name")).toMatchObject({
    message: { text: "@package/name" },
  });
});

test("the complete escaped message must fit the documented 12000-character limit", () => {
  expect(renderMarkdown("a".repeat(12_000)).kind).toBe("rendered");
  expect(renderMarkdown("a".repeat(12_001))).toMatchObject({ problem: "message_too_long" });
  expect(renderMarkdown("&".repeat(2_401))).toMatchObject({ problem: "message_too_long" });
  expect(renderMarkdown(" \n")).toMatchObject({ problem: "empty" });
});

test.each<[string, OutputProblem]>([
  ["xoxb-not-a-real-token", "slack_token"],
  [`\`https://${"user"}:${"password"}@example.com\``, "url_credentials"],
])("refuses sensitive output without repeating it: %s", (source, problem) => {
  expect(renderMarkdown(source)).toEqual({ kind: "refused", problem });
});

test("ordinary Markdown links are delegated to Slack without fetching them in the bridge", () => {
  expect(renderMarkdown("[docs](https://docs.slack.dev/)").kind).toBe("rendered");
});

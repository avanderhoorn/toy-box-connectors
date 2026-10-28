import { expect, test } from "bun:test";
import { outputProblem, type OutputProblem } from "./safety";

test.each<readonly [OutputProblem, string]>([
  ["slack_token", `xoxb-${"a".repeat(32)}`],
  ["slack_token", `xapp-1-${"b".repeat(32)}`],
  ["slack_token", `xoxe.xoxb-1-${"c".repeat(32)}`],
  ["github_token", `ghp_${"a".repeat(36)}`],
  ["github_token", `github_pat_${"a".repeat(40)}`],
  ["anthropic_key", `sk-ant-api03-${"a".repeat(80)}`],
  ["openai_key", `sk-proj-${"a".repeat(80)}`],
  ["aws_key", `AKIA${"A".repeat(16)}`],
  ["aws_key", `aws_secret_access_key = "${"a".repeat(40)}"`],
  ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ["url_credentials", `https://${"user"}:${"password"}@example.com`],
  ["url_credentials", `ftp://${"user"}:p)ass@example.com`],
])("refuses %s as text or code without returning its value", (category, secret) => {
  expect(outputProblem(`Do not publish ${secret}`)).toBe(category);
  expect(outputProblem(`\`\`\`\n${secret}\n\`\`\``)).toBe(category);
});

test("ordinary release notes and key-family names are not secrets", () => {
  expect(
    outputProblem(
      [
        `Shipped ${"a".repeat(40)}.`,
        "Prefixes xoxb- and ghp_ identify key families.",
        "-----BEGIN PUBLIC KEY-----",
        "Read https://docs.slack.dev/.",
        `ssh://${"user"}@example.com`,
      ].join("\n"),
    ),
  ).toBeNull();
});

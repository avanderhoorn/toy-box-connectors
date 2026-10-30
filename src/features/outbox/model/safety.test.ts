import { expect, test } from "bun:test";
import { outputProblem, type OutputProblem } from "./safety";

test.each<readonly [OutputProblem, string, string]>([
  ["slack_token", "app-level", `xapp-1-${"b".repeat(32)}`],
  ["github_token", "classic", `ghp_${"a".repeat(36)}`],
  ["github_token", "fine-grained", `github_pat_${"a".repeat(40)}`],
  ["anthropic_key", "API key", `sk-ant-api03-${"a".repeat(80)}`],
  ["openai_key", "project", `sk-proj-${"a".repeat(80)}`],
  ["aws_key", "access key ID", `AKIA${"A".repeat(16)}`],
  ["aws_key", "secret assigned with =", `aws_secret_access_key = "${"a".repeat(40)}"`],
  ["aws_key", "secret in JSON", `"aws_secret_access_key": "${"a".repeat(40)}"`],
  ["private_key", "OpenSSH", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ["url_credentials", "password with a parenthesis", `ftp://${"user"}:p)ass@example.com`],
])("refuses %s (%s) as text or code without returning its value", (category, _, secret) => {
  expect(outputProblem(`Do not publish ${secret}`)).toBe(category);
  expect(outputProblem(`\`\`\`\n${secret}\n\`\`\``)).toBe(category);
});

test.each([
  "Prefixes xoxb- and ghp_ identify key families.",
  "-----BEGIN PUBLIC KEY-----",
  `ssh://${"user"}@example.com`,
])("ordinary text is not a secret: %s", (source) => {
  expect(outputProblem(source)).toBeNull();
});

test("a long run of spaces can't stall the scan", () => {
  const started = performance.now();
  expect(outputProblem(`aws_secret_access_key${" ".repeat(100_000)}x`)).toBeNull();
  expect(performance.now() - started).toBeLessThan(500);
});
